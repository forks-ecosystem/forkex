package strategies

import (
    "fmt"
    "log"
    "math"

    "github.com/ixbaseANT/bot/internal/market"
    "github.com/ixbaseANT/bot/internal/models"
    "github.com/ixbaseANT/bot/internal/bot/order"
    "github.com/ixbaseANT/bot/internal/market/data"
)

type GridTrading struct {
    marketProvider data.MarketDataProvider
    orderManager   order.OrderManager
    gridLevels     int
    gridStepPct    float64
}

func NewGridTrading(
    marketProvider data.MarketDataProvider,
    orderManager order.OrderManager,
) *GridTrading {
    return &GridTrading{
	marketProvider: marketProvider,
	orderManager:   orderManager,
	gridLevels:     5,
	gridStepPct:    0.25,
    }
}

func (s *GridTrading) GetName() string {
    return "Grid Trading"
}

func (s *GridTrading) GetCodeName() string {
    return "grid_trading)"
}

// Execute — основная функция выполнения стратегии
func (s *GridTrading) Execute(ctx *models.BotContext) error {
    // Получаем параметры
//    pairID, symbol, err := s.getConfigParams(ctx)
//    if err != nil {
//        return fmt.Errorf("failed to get config params: %v", err)
//    } 
//    log.Printf("[GridTrading] pairID %d,  symbol %s", pairID, symbol)
    //
    params := ctx.Config.Parameters
    pairID := params["pairID"].(int) 
    quantity, ok := ctx.Config.Parameters["quantity"].(float64)
    if !ok || quantity <= 0 {
	quantity = 0.01 // дефолтный минимальный размер для теста
    }

    // 1. Получаем последние свечи
    candles, err := s.marketProvider.GetCandles("", "5m", 20)
    if err != nil {
	log.Printf("[GridTrading] Ошибка получения свечей для %d: %v", pairID, err)
	return err
    }

    if len(candles) < 20 {
	log.Printf("[GridTrading] Недостаточно свечей (%d < 20) для %d", len(candles), pairID)
	return nil // или return fmt.Errorf(...)
    }

    // 2. Рассчитываем Bollinger Bands (SMA20 ± 2*stdDev)
    upperBand, lowerBand := calculateBollinger(candles)
    if upperBand == 0 || lowerBand == 0 {
	log.Printf("[GridTrading] Bollinger Bands не рассчитаны для %d", pairID)
	return nil
    }

    rangeWidth := upperBand - lowerBand
    log.Printf("[GridTrading] %d | Bollinger: lower=%.8f, upper=%.8f, range=%.8f", pairID, lowerBand, upperBand, rangeWidth)

    // 3. Рассчитываем шаг грида
    step := rangeWidth * s.gridStepPct

    // 4. Размещаем BUY ордера ниже текущей цены (в пределах lower band)
    for i := 1; i <= s.gridLevels; i++ {
	buyPrice := lowerBand + float64(i)*step
	if buyPrice >= upperBand {
	    break // не размещаем выше upper band
	}

	orderData := order.OrderData{
	    PairID:    pairID,
	    Side:      "buy",
	    Type:      "limit",
	    Price:     buyPrice,
	    Quantity:  quantity,
	    ConfigID:  ctx.ConfigID,
	    BotUserID: ctx.BotUserID,
	    // Status:    "pending",              // если нужно явно
	    // Strategy:  "grid_trading",
	    // CreatedAt: time.Now(),
	}

	orderID, err := s.orderManager.SaveOrder(orderData)
	if err != nil {
	    log.Printf("[GridTrading] Ошибка размещения BUY ордера @ %.8f: %v", buyPrice, err)
	    continue
	}

	log.Printf("[GridTrading] BUY лимит @ %.8f (qty=%.6f), ID=%s", buyPrice, quantity, orderID)
    }

    // Опционально: SELL ордера выше upper band (для симметричного грида)
    // for i := 1; i <= s.gridLevels; i++ { ... }

    return nil
}


func (s *GridTrading) getConfigParams(ctx *models.BotContext) (int, string, error) {
    // Получаем pair_id
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

    // Получаем symbol
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


// calculateBollinger — простая реализация Bollinger Bands (SMA20 ± 2*stdDev)
func calculateBollinger(candles []market.Candle) (upper, lower float64) {
    n := 20
    if len(candles) < n {
	return 0, 0
    }

    // Берём последние 20 свечей
    lastCandles := candles[len(candles)-n:]

    var sum float64
    for _, c := range lastCandles {
	sum += c.Close
    }
    sma := sum / float64(n)

    var variance float64
    for _, c := range lastCandles {
	diff := c.Close - sma
	variance += diff * diff
    }
    stdDev := math.Sqrt(variance / float64(n))

    upper = sma + 2*stdDev
    lower = sma - 2*stdDev

    return upper, lower
}

func (s *GridTrading) ValidateConfig(config map[string]interface{}) error {
    return nil
}

func (s *GridTrading) CalculateMetrics(ctx *models.BotContext) map[string]interface{} {
    return map[string]interface{}{
        "strategy": "GridTrading",
    }
}
