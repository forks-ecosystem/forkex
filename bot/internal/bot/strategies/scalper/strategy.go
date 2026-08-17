// internal/bot/strategies/scalper/strategy.go
package scalper

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

// Scalper — мелкие частые сделки.
// Размещает небольшие пассивные заявки вплотную к лучшим bid/ask (улучшая спред),
// с коротким горизонтом жизни. Заявки либо быстро исполняются встречными
// маркетабельными ордерами (matching engine → REAL TRADE), либо отменяются
// по истечении горизонта и заменяются новыми. Объёмы существенно меньше
// основной ликвидности.
type Scalper struct {
	marketProvider data.MarketDataProvider
	orderManager   OrderManager
	rand           *rand.Rand
	lastPlacement  time.Time
}

func NewScalper(
	marketProvider data.MarketDataProvider,
	orderManager OrderManager,
) *Scalper {
	return &Scalper{
		marketProvider: marketProvider,
		orderManager:   orderManager,
		rand:           rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (s *Scalper) GetName() string {
	return "Scalper"
}

func (s *Scalper) GetCodeName() string {
	return "scalper"
}

func (s *Scalper) Execute(ctx *models.BotContext) error {
	pairID, symbol, err := s.getConfigParams(ctx)
	if err != nil {
		return fmt.Errorf("failed to get config params: %v", err)
	}

	orderSize := s.getConfigValue(ctx, "order_size", 0.0002)
	tighten := s.getConfigValue(ctx, "spread_tight_pct", 0.0002)
	horizon := s.getConfigValue(ctx, "horizon_sec", 150.0)
	interval := s.getConfigValue(ctx, "interval_sec", 40.0)
	maxOpen := int(s.getConfigValue(ctx, "max_open", 6.0))

	// 1. Отменяем заявки старше горизонта (короткий горизонт скальпера)
	activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
	if err == nil {
		expired := 0
		for _, ord := range activeOrders {
			if time.Since(ord.CreatedAt).Seconds() > horizon {
				if err := s.orderManager.RemoveActiveOrder(ord.OrderID); err == nil {
					expired++
				}
			}
		}
		if expired > 0 {
			log.Printf("[Scalper] Отменено истёкших заявок: %d", expired)
		}
	}

	// 2. Лимит на количество открытых заявок
	remaining := maxOpen
	if err == nil {
		remaining = maxOpen - len(activeOrders)
	}
	if remaining <= 0 {
		return nil
	}

	// 3. Минимальный интервал между размещениями
	now := time.Now()
	if now.Sub(s.lastPlacement).Seconds() < interval {
		return nil
	}

	// 4. Получаем стакан
	book, err := s.marketProvider.GetOrderBook(symbol, 5)
	if err != nil {
		log.Printf("[Scalper] Ошибка получения стакана %s: %v", symbol, err)
		return nil
	}
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		log.Printf("[Scalper] Стакан %s пуст — пропускаем цикл", symbol)
		return nil
	}

	bestBid := book.Bids[0].Price
	bestAsk := book.Asks[0].Price

	// 5. Размещаем небольшие пассивные заявки вплотную к лучшим ценам
	//    (внутри текущего спреда, не пересекая стакан)
	placed := 0
	if remaining >= 2 {
		buyPrice := s.roundPrice(bestBid * (1 + tighten))
		if buyPrice < bestAsk {
			s.placeOrder(ctx, pairID, symbol, "buy", buyPrice, orderSize)
			placed++
		}
		sellPrice := s.roundPrice(bestAsk * (1 - tighten))
		if sellPrice > bestBid {
			s.placeOrder(ctx, pairID, symbol, "sell", sellPrice, orderSize)
			placed++
		}
	} else if remaining == 1 {
		side := "buy"
		price := s.roundPrice(bestBid * (1 + tighten))
		if s.rand.Float64() < 0.5 {
			side = "sell"
			price = s.roundPrice(bestAsk * (1 - tighten))
		}
		s.placeOrder(ctx, pairID, symbol, side, price, orderSize)
		placed++
	}

	if placed > 0 {
		s.lastPlacement = now
		log.Printf("[Scalper] Размещено заявок: %d (bestBid=%g bestAsk=%g)", placed, bestBid, bestAsk)
	}

	return nil
}

func (s *Scalper) placeOrder(ctx *models.BotContext, pairID int, symbol, side string, price, quantity float64) {
	orderData := order.OrderData{
		ExecutionStrategy: s.GetName(),
		ConfigID:          ctx.ConfigID,
		BotUserID:         ctx.BotUserID,
		PairID:            pairID,
		Symbol:            symbol,
		Side:              side,
		Type:              "limit",
		Price:             price,
		Quantity:          quantity,
		Size:              quantity,
		Status:            "open",
		Remarks:           "Scalper tight passive",
	}
	if _, err := s.orderManager.SaveOrder(orderData); err != nil {
		log.Printf("[Scalper] Ошибка размещения %s @ %g: %v", side, price, err)
		return
	}
	log.Printf("[Scalper] Размещён %s %.6f @ %g", side, quantity, price)
}

func (s *Scalper) getConfigParams(ctx *models.BotContext) (int, string, error) {
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

func (s *Scalper) getConfigValue(ctx *models.BotContext, key string, defaultValue float64) float64 {
	if val, ok := ctx.Config.Parameters[key]; ok {
		if f, ok := val.(float64); ok {
			return f
		}
	}
	return defaultValue
}

func (s *Scalper) roundPrice(price float64) float64 {
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

func (s *Scalper) ValidateConfig(config map[string]interface{}) error {
	for _, key := range []string{"pair_id", "symbol"} {
		if _, ok := config[key]; !ok {
			return fmt.Errorf("%s is required", key)
		}
	}
	return nil
}

func (s *Scalper) CalculateMetrics(ctx *models.BotContext) map[string]interface{} {
	return map[string]interface{}{
		"strategy":      "Scalper",
		"last_placement": s.lastPlacement.Format(time.RFC3339),
	}
}
