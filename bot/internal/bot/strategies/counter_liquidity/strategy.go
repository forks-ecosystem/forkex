// internal/bot/strategies/counter_liquidity/strategy.go
package counter_liquidity

import (
	"fmt"
	"log"
	"math"
	"math/rand"
	"time"

	"github.com/ixbaseANT/bot/internal/bot/order"
	"github.com/ixbaseANT/bot/internal/market/data"
	"github.com/ixbaseANT/bot/internal/models"
)

// OrderManager интерфейс управления ордерами, доступный стратегии
type OrderManager interface {
	SaveOrder(orderData order.OrderData) (string, error)
	GetActiveOrders(configID int) ([]*models.Order, error)
	RemoveActiveOrder(orderID string) error
	MatchMarketableOrder(orderData order.OrderData, ioc bool) (*order.MatchResult, error)
}

// CounterLiquidity — встречная ликвидность.
// Смотрит на стакан, находит лучшие заявки рынка (главную ликвидность #100)
// и с заданной вероятностью и интервалами создаёт маркетабельный ордер,
// пересекающий существующую заявку. Исполнение идёт через matching engine —
// в trades записывается РЕАЛЬНАЯ двусторонняя сделка (maker/taker).
type CounterLiquidity struct {
	marketProvider data.MarketDataProvider
	orderManager   OrderManager
	rand           *rand.Rand
	lastAttempt    time.Time
}

func NewCounterLiquidity(
	marketProvider data.MarketDataProvider,
	orderManager OrderManager,
) *CounterLiquidity {
	return &CounterLiquidity{
		marketProvider: marketProvider,
		orderManager:   orderManager,
		rand:           rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (s *CounterLiquidity) GetName() string {
	return "Counter Liquidity"
}

func (s *CounterLiquidity) GetCodeName() string {
	return "counter_liquidity"
}

func (s *CounterLiquidity) Execute(ctx *models.BotContext) error {
	pairID, symbol, err := s.getConfigParams(ctx)
	if err != nil {
		return fmt.Errorf("failed to get config params: %v", err)
	}

	orderSize := s.getConfigValue(ctx, "order_size", 0.001)
	tradeProbability := s.getConfigValue(ctx, "trade_probability", 0.3)
	minInterval := s.getConfigValue(ctx, "min_interval_sec", 120.0)
	maxInterval := s.getConfigValue(ctx, "max_interval_sec", 300.0)
	buyProbability := s.getConfigValue(ctx, "buy_probability", 0.5)
	aggressiveness := s.getConfigValue(ctx, "price_aggressiveness", 0.001)
	ttl := s.getConfigValue(ctx, "ttl_sec", 900.0)

	// 1. Отменяем собственные устаревшие заявки
	s.cancelStaleOrders(ctx, int(ttl))

	// 2. Получаем стакан
	book, err := s.marketProvider.GetOrderBook(symbol, 5)
	if err != nil {
		log.Printf("[CounterLiquidity] Ошибка получения стакана %s: %v", symbol, err)
		return nil
	}
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		log.Printf("[CounterLiquidity] Стакан %s пуст — пропускаем цикл", symbol)
		return nil
	}

	bestBid := book.Bids[0].Price
	bestAsk := book.Asks[0].Price

	// 3. Вероятностное гейтирование попытки сделки
	now := time.Now()
	since := now.Sub(s.lastAttempt).Seconds()
	shouldAttempt := false
	reason := ""
	if since >= maxInterval {
		shouldAttempt = true
		reason = "forced (max interval)"
	} else if since >= minInterval {
		shouldAttempt = s.rand.Float64() < tradeProbability
		if shouldAttempt {
			reason = "probability"
		}
	} else {
		reason = "min interval not elapsed"
	}
	if !shouldAttempt {
		log.Printf("[CounterLiquidity] Пропуск сделки: %s (%.0f с с последней попытки)", reason, since)
		return nil
	}

	// 4. Выбираем сторону и маркетабельную цену за пределами лучшей заявки
	side := "buy"
	price := bestAsk * (1 + aggressiveness)
	if s.rand.Float64() >= buyProbability {
		side = "sell"
		price = bestBid * (1 - aggressiveness)
	}
	price = s.roundPrice(price)

	log.Printf("[CounterLiquidity] Попытка %s %g @ %g (bestBid=%g bestAsk=%g)",
		side, orderSize, price, bestBid, bestAsk)

	orderData := order.OrderData{
		ExecutionStrategy: s.GetName(),
		ConfigID:          ctx.ConfigID,
		BotUserID:         ctx.BotUserID,
		PairID:            pairID,
		Symbol:            symbol,
		Side:              side,
		Type:              "limit",
		Price:             price,
		Quantity:          orderSize,
		Size:              orderSize,
		Status:            "open",
		Remarks:           "Counter Liquidity marketable",
	}

	// 5. Маркетабельный ордер → matching engine (IOC: остаток отменяем)
	res, err := s.orderManager.MatchMarketableOrder(orderData, true)
	if err != nil {
		log.Printf("[CounterLiquidity] Ошибка исполнения: %v", err)
		return nil
	}

	if res.Filled {
		log.Printf("[CounterLiquidity] ✅ Исполнено: %g %s @ %g, сделок: %d",
			res.FilledQuantity, symbol, res.ExecutionPrice, res.Trades)
	} else {
		log.Printf("[CounterLiquidity] Частично/не исполнено: filled=%g остаток=%g",
			res.FilledQuantity, res.Remaining)
	}

	s.lastAttempt = now
	return nil
}

func (s *CounterLiquidity) cancelStaleOrders(ctx *models.BotContext, ttlSeconds int) {
	activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
	if err != nil {
		return
	}
	for _, ord := range activeOrders {
		if time.Since(ord.CreatedAt).Seconds() > float64(ttlSeconds) {
			if err := s.orderManager.RemoveActiveOrder(ord.OrderID); err != nil {
				log.Printf("[CounterLiquidity] Ошибка отмены %s: %v", ord.OrderID, err)
			} else {
				log.Printf("[CounterLiquidity] Отменён устаревший ордер %s", ord.OrderID)
			}
		}
	}
}

func (s *CounterLiquidity) getConfigParams(ctx *models.BotContext) (int, string, error) {
	pairIDRaw, ok := ctx.Config.Parameters["pair_id"]
	if !ok {
		return 0, "", fmt.Errorf("pair_id not found in config")
	}
	var pairID int
	switch v := pairIDRaw.(type) {
	case int:
		pairID = v
	case float64:
		pairID = int(v)
	default:
		return 0, "", fmt.Errorf("invalid pair_id type: %T", pairIDRaw)
	}

	symbolRaw, ok := ctx.Config.Parameters["symbol"]
	if !ok {
		return 0, "", fmt.Errorf("symbol not found in config")
	}
	symbol, ok := symbolRaw.(string)
	if !ok {
		return 0, "", fmt.Errorf("invalid symbol type: %T", symbolRaw)
	}
	return pairID, symbol, nil
}

func (s *CounterLiquidity) getConfigValue(ctx *models.BotContext, key string, defaultValue float64) float64 {
	if val, ok := ctx.Config.Parameters[key]; ok {
		if f, ok := val.(float64); ok {
			return f
		}
	}
	return defaultValue
}

func (s *CounterLiquidity) roundPrice(price float64) float64 {
	var decimals int
	switch {
	case price >= 1000:
		decimals = 0
	case price >= 100:
		decimals = 1
	case price >= 1:
		decimals = 2
	case price >= 0.01:
		decimals = 4
	case price >= 0.0001:
		decimals = 8
	default:
		decimals = 10
	}
	multiplier := math.Pow10(decimals)
	return math.Round(price*multiplier) / multiplier
}

func (s *CounterLiquidity) ValidateConfig(config map[string]interface{}) error {
	for _, key := range []string{"pair_id", "symbol"} {
		if _, ok := config[key]; !ok {
			return fmt.Errorf("%s is required", key)
		}
	}
	return nil
}

func (s *CounterLiquidity) CalculateMetrics(ctx *models.BotContext) map[string]interface{} {
	return map[string]interface{}{
		"strategy":     "Counter Liquidity",
		"last_attempt": s.lastAttempt.Format(time.RFC3339),
	}
}
