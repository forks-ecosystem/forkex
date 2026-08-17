package order

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/ixbaseANT/bot/internal/models"
	"github.com/jackc/pgx/v5"
)

// MatchResult результат исполнения маркетабельного ордера через matching engine
type MatchResult struct {
	OrderID        string
	Filled         bool
	FilledQuantity float64
	Remaining      float64
	ExecutionPrice float64
	ExecutionTime  time.Time
	Trades         int
}

const fillEpsilon = 1e-10

// MatchMarketableOrder размещает маркетабельный (пересекающий стакан) ордер
// и исполняет его через matching engine против встречных заявок в книге.
// Каждая встречающаяся заявка (maker) обновляется (частично/полностью), а в
// таблицу trades пишется реальная сделка с корректными maker_id/taker_id.
// Если ioc=true и ордер не исполнился полностью — остаток отменяется.
func (r *OrderRepository) MatchMarketableOrder(orderData OrderData, ioc bool) (*MatchResult, error) {
	ctx := context.Background()

	if orderData.Side != "buy" && orderData.Side != "sell" {
		return nil, fmt.Errorf("invalid side %q for marketable order", orderData.Side)
	}
	if orderData.Quantity <= 0 {
		if orderData.Size > 0 {
			orderData.Quantity = orderData.Size
		} else {
			return nil, fmt.Errorf("marketable order quantity must be > 0")
		}
	}
	if orderData.Symbol == "" {
		return nil, fmt.Errorf("marketable order symbol is required")
	}

	orderID, err := r.SaveOrder(orderData)
	if err != nil {
		return nil, err
	}

	remaining := orderData.Quantity
	executionPrice := 0.0
	trades := 0

	resting, err := r.loadRestingOrders(ctx, orderData)
	if err != nil {
		return nil, fmt.Errorf("failed to load resting orders: %v", err)
	}

	for _, rest := range resting {
		if remaining <= fillEpsilon {
			break
		}
		matched := math.Min(remaining, rest.Size)
		if matched <= fillEpsilon {
			continue
		}
		if !r.decrementRestingOrder(ctx, rest, matched) {
			continue
		}
		if err := r.insertMatchedTrade(rest, orderData, matched, rest.Price, time.Now()); err != nil {
			log.Printf("[Matching] Failed to insert trade: %v", err)
			continue
		}
		if rest.Size-matched <= fillEpsilon {
			r.recordOrderEvent(rest, models.EventOrderFilled)
		}
		remaining -= matched
		executionPrice = rest.Price
		trades++
	}

	filledQty := orderData.Quantity - remaining

	if remaining <= fillEpsilon {
		// Полное исполнение
		r.finalizeTakerOrder(ctx, orderID, "filled", orderData.Quantity)
		r.recordOrderEvent(orderData, models.EventOrderFilled)
	} else if filledQty > fillEpsilon {
		// Частичное исполнение — остаток остаётся в стакане либо отменяется
		_, _ = r.db.Exec(ctx,
			`UPDATE orders SET size = $1, quantity = $1, updated_at = NOW() WHERE order_id = $2 AND status = 'open'`,
			remaining, orderID)
		if ioc {
			if err := r.CancelOrder(orderID); err != nil {
				log.Printf("[Matching] Failed to cancel leftover %s: %v", orderID, err)
			}
		}
	} else {
		if ioc {
			if err := r.CancelOrder(orderID); err != nil {
				log.Printf("[Matching] Failed to cancel unfilled %s: %v", orderID, err)
			}
		}
	}

	return &MatchResult{
		OrderID:        orderID,
		Filled:         remaining <= fillEpsilon,
		FilledQuantity: filledQty,
		Remaining:      remaining,
		ExecutionPrice: executionPrice,
		ExecutionTime:  time.Now(),
		Trades:         trades,
	}, nil
}

// loadRestingOrders возвращает встречные заявки книги, пересекающие цену ордера,
// в порядке ценового приоритета (лучшие первыми), исключая собственные заявки.
func (r *OrderRepository) loadRestingOrders(ctx context.Context, orderData OrderData) ([]OrderData, error) {
	var query string
	if orderData.Side == "buy" {
		query = `
			SELECT id, order_id, user_id, config_id, bot_user_id, symbol, side, price, size, quantity
			FROM orders
			WHERE pair_id = $1 AND status = 'open'
			  AND side = 'sell'
			  AND price <= $2
			  AND config_id <> $3 AND bot_user_id <> $4
			ORDER BY price ASC, created_at ASC
			LIMIT 50
		`
	} else {
		query = `
			SELECT id, order_id, user_id, config_id, bot_user_id, symbol, side, price, size, quantity
			FROM orders
			WHERE pair_id = $1 AND status = 'open'
			  AND side = 'buy'
			  AND price >= $2
			  AND config_id <> $3 AND bot_user_id <> $4
			ORDER BY price DESC, created_at ASC
			LIMIT 50
		`
	}

	rows, err := r.db.Query(ctx, query,
		orderData.PairID, orderData.Price, orderData.ConfigID, orderData.BotUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var resting []OrderData
	for rows.Next() {
		var o OrderData
		if err := rows.Scan(
			&o.ID, &o.OrderID, &o.UserID, &o.ConfigID, &o.BotUserID,
			&o.Symbol, &o.Side, &o.Price, &o.Size, &o.Quantity,
		); err != nil {
			log.Printf("[Matching] Error scanning resting order: %v", err)
			continue
		}
		if o.Quantity <= 0 {
			o.Quantity = o.Size
		}
		resting = append(resting, o)
	}
	return resting, rows.Err()
}

// decrementRestingOrder уменьшает объём встречной заявки или помечает её исполненной.
// Возвращает false, если заявка уже была изменена конкурирующим исполнением.
func (r *OrderRepository) decrementRestingOrder(ctx context.Context, rest OrderData, matched float64) bool {
	newSize := rest.Size - matched
	if newSize <= fillEpsilon {
		res, err := r.db.Exec(ctx,
			`UPDATE orders
			 SET status = 'filled', accepted = true, accepted_amount = $1, size = 0, quantity = 0,
			     updated_at = NOW()
			 WHERE id = $2 AND status = 'open'`,
			rest.Size, rest.ID)
		if err != nil {
			log.Printf("[Matching] Failed to fill resting order %d: %v", rest.ID, err)
			return false
		}
		if res.RowsAffected() == 0 {
			return false
		}
	} else {
		res, err := r.db.Exec(ctx,
			`UPDATE orders SET size = $1, quantity = $1, updated_at = NOW()
			 WHERE id = $2 AND status = 'open'`,
			newSize, rest.ID)
		if err != nil {
			log.Printf("[Matching] Failed to reduce resting order %d: %v", rest.ID, err)
			return false
		}
		if res.RowsAffected() == 0 {
			return false
		}
	}
	return true
}

// finalizeTakerOrder обновляет статус маркетабельного ордера после полного исполнения
func (r *OrderRepository) finalizeTakerOrder(ctx context.Context, orderID, status string, acceptedAmount float64) {
	_, err := r.db.Exec(ctx,
		`UPDATE orders
		 SET status = $1, accepted = true, accepted_amount = $2,
		     updated_at = NOW()
		 WHERE order_id = $3 AND status = 'open'`,
		status, acceptedAmount, orderID)
	if err != nil {
		log.Printf("[Matching] Failed to finalize taker order %s: %v", orderID, err)
	}
}

// insertMatchedTrade записывает реальную двустороннюю сделку:
// maker — встречная (пассивная) заявка, taker — маркетабельный ордер.
func (r *OrderRepository) insertMatchedTrade(maker, taker OrderData, quantity, price float64, now time.Time) error {
	ctx := context.Background()

	makerUUID, err := uuid.Parse(maker.OrderID)
	if err != nil {
		makerUUID = uuid.New()
	}
	takerUUID, err := uuid.Parse(taker.OrderID)
	if err != nil {
		takerUUID = uuid.New()
	}

	tradeValue := price * quantity
	makerFee := tradeValue * 0.001 // 0.1%
	takerFee := tradeValue * 0.002 // 0.2%
	baseCoin := baseCoinForSymbol(taker.Symbol)

	query := `
		INSERT INTO trades (
			side, symbol, size, price,
			maker_order_id, taker_order_id, timestamp,
			maker_fee, taker_fee,
			maker_fee_coin, taker_fee_coin,
			quick, maker_id, taker_id,
			maker_network_id, taker_network_id,
			pair_id, created_at, updated_at,
			quantity, direction
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
			$11, $12, $13, $14, $15, $16, $17, $18, $19,
			$20, $21
		)
		RETURNING id
	`

	var tradeID int
	err = r.db.QueryRow(ctx, query,
		taker.Side, taker.Symbol, quantity, price,
		makerUUID, takerUUID, now,
		makerFee, takerFee,
		"usdt", baseCoin,
		true, maker.BotUserID, taker.BotUserID,
		1, 1,
		taker.PairID, now, now,
		quantity, taker.Side,
	).Scan(&tradeID)

	if err != nil {
		return fmt.Errorf("failed to record trade: %v", err)
	}

	log.Printf("[Matching] REAL TRADE #%d: %s %.8f %s @ %.8f (maker #%d, taker #%d)",
		tradeID, taker.Side, quantity, taker.Symbol, price, maker.BotUserID, taker.BotUserID)

	r.updateCandle5m(ctx, taker.PairID, price, quantity, now)

	return nil
}

// updateCandle5m обновляет текущую 5-минутную свечу пары после реальной сделки,
// чтобы терминальный график оставался живым.
func (r *OrderRepository) updateCandle5m(ctx context.Context, pairID int, price, size float64, now time.Time) {
	bucket := now.Truncate(5 * time.Minute).Unix()

	var id int
	var open, high, low, close_, volume float64
	err := r.db.QueryRow(ctx,
		`SELECT id, open, high, low, close, volume FROM candles
		 WHERE pair_id = $1 AND timeframe = '5m' AND timestamp = $2`,
		pairID, bucket).Scan(&id, &open, &high, &low, &close_, &volume)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			log.Printf("[Matching] Failed to read candle for pair %d: %v", pairID, err)
			return
		}
		_, err = r.db.Exec(ctx,
			`INSERT INTO candles (pair_id, timeframe, timestamp, open, high, low, close, volume)
			 VALUES ($1, '5m', $2, $3, $3, $3, $3, $4)`,
			pairID, bucket, price, size)
		if err != nil {
			log.Printf("[Matching] Failed to insert candle for pair %d: %v", pairID, err)
		}
		return
	}
	if price > high {
		high = price
	}
	if price < low {
		low = price
	}
	_, err = r.db.Exec(ctx,
		`UPDATE candles SET high = $1, low = $2, close = $3, volume = $4
		 WHERE id = $5`,
		high, low, price, volume+size, id)
	if err != nil {
		log.Printf("[Matching] Failed to update candle %d: %v", id, err)
	}
}

// baseCoinForSymbol извлекает базовую монету из символа пары
func baseCoinForSymbol(symbol string) string {
	s := strings.ToLower(strings.TrimSpace(symbol))
	if idx := strings.IndexAny(s, "-/"); idx > 0 {
		return s[:idx]
	}
	for _, suffix := range []string{"usdt", "usdc", "btc", "eth"} {
		if strings.HasSuffix(s, suffix) {
			return strings.TrimSuffix(s, suffix)
		}
	}
	return s
}
