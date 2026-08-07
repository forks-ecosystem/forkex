// internal/bot/strategies/conservative_mm/strategy.go
package conservative_mm

import (
    "fmt"
    "log"
    "math"
    "math/rand"
    "time"
    
    "github.com/ixbaseANT/bot/internal/bot/order"
    "github.com/ixbaseANT/bot/internal/market"
    "github.com/ixbaseANT/bot/internal/market/data"
    "github.com/ixbaseANT/bot/internal/models"
)

// OrderRepository интерфейс для работы с ордерами
type OrderRepository interface {
    GetActiveOrders(configID int) ([]*models.Order, error)
    UpdateOrderStatus(orderID, status string, filledQuantity float64) error
    CancelOldOrders(configID int, maxAgeMinutes int) (int, error)
    RemoveActiveOrder(orderID string) error
}

// StatsRepository интерфейс для работы со статистикой
type StatsRepository interface {
    IncrementExecutedOrders(ctx *models.BotContext, side string, count int, volume float64) error
    GetExecutedStats(ctx *models.BotContext) (map[string]interface{}, error)
    UpdateStats(configID int, volume float64, trades int) error
}

// OrderManager интерфейс для управления ордерами
type OrderManager interface {
    SaveOrder(orderData order.OrderData) (string, error)
    GetActiveOrders(configID int) ([]*models.Order, error)
    RemoveActiveOrder(orderID string) error
    UpdateOrderStatus(orderID string, status string, executedPrice float64) error
}

type orderManagerAdapter struct {
    inner OrderManager
}

func (a *orderManagerAdapter) GetActiveOrders(configID int) ([]*models.Order, error) {
    return a.inner.GetActiveOrders(configID)
}

func (a *orderManagerAdapter) RemoveActiveOrder(orderID string) error {
    return a.inner.RemoveActiveOrder(orderID)
}

// Position структура для отслеживания позиции
type Position struct {
    BaseBalance  float64
    QuoteBalance float64
}

// ConservativeMarketMaker основная структура стратегии
type ConservativeMarketMaker struct {
    marketProvider data.MarketDataProvider
    orderManager   OrderManager
    analyzer       *MarketAnalyzer
    rand           *rand.Rand
    positions      map[int]*Position // configID -> position
    lastMidPrice   float64
}

func NewConservativeMarketMaker(
    marketProvider data.MarketDataProvider,
    orderManager OrderManager,
) *ConservativeMarketMaker {
    return &ConservativeMarketMaker{
        marketProvider: marketProvider,
        orderManager:   orderManager,
        analyzer:       NewMarketAnalyzer(marketProvider),
        rand:           rand.New(rand.NewSource(time.Now().UnixNano())),
        positions:      make(map[int]*Position),
    }
}

func (s *ConservativeMarketMaker) GetPosition(configID int) *Position {
    if pos, ok := s.positions[configID]; ok {
        return pos
    }
    return &Position{BaseBalance: 0, QuoteBalance: 0}
}

func (s *ConservativeMarketMaker) SetPosition(configID int, pos *Position) {
    s.positions[configID] = pos
}

func (s *ConservativeMarketMaker) GetName() string {
    return "Conservative Market Maker"
}

func (s *ConservativeMarketMaker) GetCodeName() string {
    return "conservative_market_maker"
}

func (s *ConservativeMarketMaker) Execute(ctx *models.BotContext) error {
    startTime := time.Now()
    
    // Получаем параметры
    pairID, symbol, err := s.getConfigParams(ctx)
    if err != nil {
        return fmt.Errorf("failed to get config params: %v", err)
    }
    
    // Получаем данные рынка
    price, _ := s.marketProvider.GetMarketPrice(symbol)
    candles, _ := s.marketProvider.GetCandles(symbol, "5m", 24)
    orderBook, _ := s.marketProvider.GetOrderBook(symbol, 20)
    
    snapshot := &market.MarketSnapshot{
        PairID:    pairID,
        Timestamp: time.Now(),
        MarketData: market.MarketData{
            PairID:       pairID,
            Symbol:       symbol,
            Timestamp:    time.Now(),
            CurrentPrice: price,
            BidPrice:     price * 0.9995,
            AskPrice:     price * 1.0005,
            Spread:       0.1,
        },
        OrderBook: &orderBook,
    }
    if len(candles) > 0 {
        snapshot.LastCandle = &candles[len(candles)-1]
    }
    
    // Анализируем рынок
    analyzer := NewMarketAnalyzer(s.marketProvider)
    conditions, err := analyzer.Analyze(pairID, symbol)
    if err != nil {
        log.Printf("[ConservativeMM] Ошибка анализа рынка: %v", err)
    }
    
    currentPrice := price
    log.Printf("[ConservativeMM] ====== ЦИКЛ МАРКЕТ-МЕЙКЕРА %s =====", symbol)
    log.Printf("[ConservativeMM] Текущая цена: %g", currentPrice)

    // 1. Очищаем старые ордера
    maxAgeMinutes := int(s.getConfigValue(ctx, "max_order_age_minutes", 30.0))
    s.cleanupOldOrders(ctx, maxAgeMinutes)
    
    // 2. ПРОВЕРЯЕМ ИСПОЛНЕНИЕ СО СТАКАНОМ (самое важное!)
    s.checkExecutionWithOrderBook(ctx, snapshot)
    
    // 3. Размещаем новые ордера с учетом анализа
    s.placeSmartOrders(ctx, snapshot, conditions)
    
    // 5. Логируем статистику
    s.logEnhancedStatistics(ctx, conditions)
    
    log.Printf("[ConservativeMM] Цикл выполнен за %v", time.Since(startTime))
    
    return nil
}

func (s *ConservativeMarketMaker) analyzeCandlesForPrediction(
    ctx *models.BotContext, 
    candles map[string][]market.Candle,
) {
    // Анализируем 5-минутные свечи для краткосрочного прогноза
    if candles5m, ok := candles["5m"]; ok && len(candles5m) > 5 {
        last5 := candles5m[len(candles5m)-5:]
        
        // Проверяем паттерны
        if s.isBreakoutPattern(last5) {
            log.Printf("[ConservativeMM] Обнаружен паттерн пробоя!")
            // Можно увеличить количество ордеров в направлении пробоя
        }
        
        if s.isReversalPattern(last5) {
            log.Printf("[ConservativeMM] Обнаружен паттерн разворота!")
            // Можно скорректировать позиции
        }
    }
}

func (s *ConservativeMarketMaker) isBreakoutPattern(candles []market.Candle) bool {
    if len(candles) < 3 {
        return false
    }
    
    // Проверяем сжатие волатильности и последующий пробой
    var ranges []float64
    for i := 0; i < len(candles)-1; i++ {
        ranges = append(ranges, candles[i].High-candles[i].Low)
    }
    
    // Если последний диапазон значительно больше среднего
    var avgRange float64
    for _, r := range ranges[:len(ranges)-1] {
        avgRange += r
    }
    avgRange /= float64(len(ranges) - 1)
    
    lastRange := candles[len(candles)-1].High - candles[len(candles)-1].Low
    
    return lastRange > avgRange*1.5
}

func (s *ConservativeMarketMaker) isReversalPattern(candles []market.Candle) bool {
    if len(candles) < 3 {
        return false
    }
    
    // Проверяем паттерн "вечерняя звезда" или "утренняя звезда"
    first := candles[len(candles)-3]
    second := candles[len(candles)-2]
    third := candles[len(candles)-1]
    
    // Простая проверка разворота
    if first.Close > first.Open && // Первая свеча бычья
        second.Close < second.Open && // Вторая медвежья
        third.Close < third.Open && // Третья медвежья
        third.Close < first.Low { // Пробитие минимума
        return true
    }
    
    return false
}

func (s *ConservativeMarketMaker) logEnhancedStatistics(
    ctx *models.BotContext, 
    conditions *MarketConditions,
) {
    position := s.GetPosition(ctx.ConfigID)
    activeOrders, _ := s.orderManager.GetActiveOrders(ctx.ConfigID)
    
    // Считаем статистику по активным ордерам
    buyCount, sellCount := 0, 0
    buyVolume, sellVolume := 0.0, 0.0
    
    for _, ord := range activeOrders {
        if ord.Side == "buy" {
            buyCount++
            buyVolume += ord.Quantity
        } else {
            sellCount++
            sellVolume += ord.Quantity
        }
    }
    
    log.Printf("[ConservativeMM] ========== СТАТИСТИКА ==========")
    log.Printf("[ConservativeMM] Позиция: Base=%.6f, Quote=%.2f", 
        position.BaseBalance, position.QuoteBalance)
    log.Printf("[ConservativeMM] Активные ордера: BUY=%d (%.4f), SELL=%d (%.4f)", 
        buyCount, buyVolume, sellCount, sellVolume)
    
    if conditions != nil {
        log.Printf("[ConservativeMM] Рыночные условия: %s, Волат=%.2f%%, Имбаланс=%.2f", 
            conditions.Trend, conditions.Volatility*100, conditions.OrderBookImbalance)
    }
}

// cleanupOldOrders отменяет старые ордера
func (s *ConservativeMarketMaker) cleanupOldOrders(ctx *models.BotContext, maxAgeMinutes int) {
    activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
    if err == nil && len(activeOrders) > 0 {
        for _, order := range activeOrders {
            age := time.Since(order.CreatedAt)
            if age.Minutes() > float64(maxAgeMinutes) {
                s.orderManager.RemoveActiveOrder(order.OrderID)
                log.Printf("[ConservativeMM] Отменен старый ордер %s (возраст: %.0f мин)", 
                    order.OrderID, age.Minutes())
            }
        }
    }
}
// logStatistics логирует статистику по ордерам
func (s *ConservativeMarketMaker) logStatistics(ctx *models.BotContext) {
    activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
    if err != nil {
        return
    }
    
    var filledOrders []*models.Order
    
    // Статистика по активным ордерам
    activeBuyCount := 0
    activeSellCount := 0
    activeBuyValue := 0.0
    activeSellValue := 0.0
    
    for _, ord := range activeOrders {
        value := ord.Price * ord.Quantity
        if ord.Side == "buy" {
            activeBuyCount++
            activeBuyValue += value
        } else if ord.Side == "sell" {
            activeSellCount++
            activeSellValue += value
        }
    }
    
    // Статистика по исполненным ордерам
    filledBuyCount := 0
    filledSellCount := 0
    filledBuyValue := 0.0
    filledSellValue := 0.0
    
    for _, ord := range filledOrders {
        value := ord.Price * ord.Quantity
        if ord.Side == "buy" {
            filledBuyCount++
            filledBuyValue += value
        } else if ord.Side == "sell" {
            filledSellCount++
            filledSellValue += value
        }
    }
    
    log.Printf("[ConservativeMM]  Статистика:")
    log.Printf("[ConservativeMM]   Активные: BUY=%d (%.2f), SELL=%d (%.2f)", 
        activeBuyCount, activeBuyValue, activeSellCount, activeSellValue)
    log.Printf("[ConservativeMM]   Исполненные: BUY=%d (%.2f), SELL=%d (%.2f)", 
        filledBuyCount, filledBuyValue, filledSellCount, filledSellValue)
    
    // Расчет P&L
    if filledBuyCount > 0 && filledSellCount > 0 {
        totalProfit := filledSellValue - filledBuyValue
        avgBuyPrice := filledBuyValue / (float64(filledBuyCount) * 0.01) // предполагаем 0.01 BTC на ордер
        avgSellPrice := filledSellValue / (float64(filledSellCount) * 0.01)
        profitPerTrade := totalProfit / float64(filledBuyCount + filledSellCount)
        
        log.Printf("[ConservativeMM]    P&L: общая=%.2f, средняя за сделку=%.2f", 
            totalProfit, profitPerTrade)
        log.Printf("[ConservativeMM]    Средние цены: покупка=%.2f, продажа=%.2f, спред=%.2f%%", 
            avgBuyPrice, avgSellPrice, ((avgSellPrice-avgBuyPrice)/avgBuyPrice)*100)
    }
}
func (s *ConservativeMarketMaker) __logStatistics(ctx *models.BotContext) {
    activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
    if err != nil {
        return
    }
    
    log.Printf("[ConservativeMM] Статистика: активных=%d", 
        len(activeOrders))
}

func (s *ConservativeMarketMaker) getConfigParams(ctx *models.BotContext) (int, string, error) {
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

// analyzeMarket анализирует рынок с учетом текущего состояния
func (s *ConservativeMarketMaker) analyzeMarket(snapshot *market.MarketSnapshot) (float64, float64, float64, string) {
    marketData := snapshot.MarketData
    
    // Получаем лучшие цены из стакана или рыночных данных
    var bestBid, bestAsk, midPrice float64
    
    if snapshot.OrderBook != nil && len(snapshot.OrderBook.Bids) > 0 && len(snapshot.OrderBook.Asks) > 0 {
        bestBid = snapshot.OrderBook.Bids[0].Price
        bestAsk = snapshot.OrderBook.Asks[0].Price
        midPrice = (bestBid + bestAsk) / 2
    } else {
        // Используем рыночные данные
        bestBid = marketData.BidPrice
        bestAsk = marketData.AskPrice
        midPrice = marketData.CurrentPrice
    }

    // Рассчитываем спред
    spread := bestAsk - bestBid
    spreadPct := spread / midPrice

    // Определяем тренд по нескольким источникам
    trend := s.analyzeTrend(snapshot, midPrice)

    // Определяем справедливую цену с учетом тренда и волатильности
    fairPrice := s.calculateFairPrice(snapshot, midPrice, trend)

    log.Printf("[ConservativeMM] Анализ: bid=%.2f, ask=%.2f, mid=%.2f, fair=%.2f, spread=%.4f%%, тренд=%s",
        bestBid, bestAsk, midPrice, fairPrice, spreadPct*100, trend)

    return fairPrice, midPrice, spreadPct, trend
}

// analyzeTrend анализирует тренд на рынке
func (s *ConservativeMarketMaker) analyzeTrend(snapshot *market.MarketSnapshot, currentMidPrice float64) string {
    var trendFactors []string
    
    // 1. Тренд по свечам
    if snapshot.LastCandle != nil {
        if snapshot.LastCandle.Close > snapshot.LastCandle.Open {
            trendFactors = append(trendFactors, "bullish_candle")
        } else if snapshot.LastCandle.Close < snapshot.LastCandle.Open {
            trendFactors = append(trendFactors, "bearish_candle")
        }
    }
    
    // 2. Тренд по изменению цены
    if snapshot.MarketData.Change24h > 0 {
        trendFactors = append(trendFactors, "positive_24h")
    } else if snapshot.MarketData.Change24h < 0 {
        trendFactors = append(trendFactors, "negative_24h")
    }
    
    // 3. Тренд по сравнению с предыдущей средней ценой
    if s.lastMidPrice > 0 {
        priceChangePct := (currentMidPrice - s.lastMidPrice) / s.lastMidPrice * 100
        if priceChangePct > 0.1 {
            trendFactors = append(trendFactors, "up_trend")
        } else if priceChangePct < -0.1 {
            trendFactors = append(trendFactors, "down_trend")
        }
    }
    s.lastMidPrice = currentMidPrice
    
    // 4. Проверяем индикаторы
    if indicators := snapshot.Indicators; len(indicators) > 0 {
        // Используем RSI
        if rsi, ok := indicators["rsi_14"]; ok {
            if rsi > 70 {
                trendFactors = append(trendFactors, "overbought")
            } else if rsi < 30 {
                trendFactors = append(trendFactors, "oversold")
            }
        }
        
        // Используем скользящие средние
        if sma20, ok := indicators["sma_20"]; ok {
            if currentMidPrice > sma20 {
                trendFactors = append(trendFactors, "above_sma20")
            } else {
                trendFactors = append(trendFactors, "below_sma20")
            }
        }
    }
    
    // Анализируем факторы тренда
    bullishCount := 0
    bearishCount := 0
    
    for _, factor := range trendFactors {
        switch factor {
        case "bullish_candle", "positive_24h", "up_trend", "above_sma20":
            bullishCount++
        case "bearish_candle", "negative_24h", "down_trend", "below_sma20":
            bearishCount++
        }
    }
    
    if bullishCount > bearishCount + 1 {
        return "bullish"
    } else if bearishCount > bullishCount + 1 {
        return "bearish"
    } else {
        return "neutral"
    }
}

// calculateFairPrice рассчитывает справедливую цену с учетом рынка
func (s *ConservativeMarketMaker) calculateFairPrice(snapshot *market.MarketSnapshot, currentMidPrice float64, trend string) float64 {
    var weights []struct {
        price float64
        weight float64
    }
    
    // 1. Текущая рыночная цена (основной вес)
    weights = append(weights, struct {
        price  float64
        weight float64
    }{price: currentMidPrice, weight: 0.4})
    
    // 2. Используем индикаторы, если есть
    if indicators := snapshot.Indicators; len(indicators) > 0 {
        // SMA20
        if sma20, ok := indicators["sma_20"]; ok && sma20 > 0 {
            weights = append(weights, struct {
                price  float64
                weight float64
            }{price: sma20, weight: 0.3})
        }
        
        // Bollinger Bands
        if bbMiddle, ok := indicators["bb_middle"]; ok && bbMiddle > 0 {
            weights = append(weights, struct {
                price  float64
                weight float64
            }{price: bbMiddle, weight: 0.2})
        }
    }
    
    // 3. Корректируем в зависимости от тренда
    adjustment := 0.0
    switch trend {
    case "bullish":
        adjustment = currentMidPrice * 0.001 // +0.1%
    case "bearish":
        adjustment = -currentMidPrice * 0.001 // -0.1%
    }
    
    // Рассчитываем взвешенную цену
    weightedPrice := 0.0
    totalWeight := 0.0
    for _, w := range weights {
        weightedPrice += w.price * w.weight
        totalWeight += w.weight
    }
    
    if totalWeight > 0 {
        fairPrice := weightedPrice / totalWeight
        // Применяем корректировку тренда
        fairPrice += adjustment
        return fairPrice
    }
    
    // Если не удалось рассчитать, используем текущую цену
    return currentMidPrice
}

func (s *ConservativeMarketMaker) placeOrdersBasedOnMarket(
    ctx *models.BotContext,
    snapshot *market.MarketSnapshot,
) {
/*
    // Отменяем все открытые ордера этого бота
    activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
    if err == nil {
        for _, o := range activeOrders {
            err := s.orderManager.CancelOrder(o.OrderID)
            if err != nil { log.Printf("Cancel failed for %s: %v", o.OrderID, err)
            } else {        log.Printf("Cancelled old order %s", o.OrderID)
            }
        }
    }
*/
    // Анализируем рынок
    fairPrice, midPrice, spreadPct, trend := s.analyzeMarket(snapshot)

    // Получаем текущую рыночную цену из снапшота
    currentPrice := snapshot.MarketData.CurrentPrice

    log.Printf("[ConservativeMM] Текущая цена: %g, FairPrice: %g, MidPrice: %g, разница: %.4f%%",
        currentPrice, fairPrice, midPrice, (fairPrice-currentPrice)/currentPrice*100)

    // Если разница слишком большая (>5%), корректируем fairPrice к currentPrice
    if math.Abs(fairPrice - currentPrice) / currentPrice > 0.05 {
        log.Printf("[ConservativeMM] Корректируем FairPrice: было %.2f, станет %.2f (разница >5%%)",
            fairPrice, currentPrice)
        fairPrice = currentPrice
        // Пересчитываем midPrice если он тоже слишком далеко
        if math.Abs(midPrice - currentPrice) / currentPrice > 0.05 {
            midPrice = currentPrice
        }
    }

    // Получаем параметры из конфига
    levels := int(s.getConfigValue(ctx, "levels", 2.0))
    baseSize := s.getConfigValue(ctx, "base_size", 0.01)
    spreadMultiplier := s.getConfigValue(ctx, "spread_multiplier", 1.0)
    maxSpreadPct := s.getConfigValue(ctx, "max_spread_pct", 0.02) // макс 2%
    skewFactor := s.getConfigValue(ctx, "skew_factor", 0.0) // смещение из-за тренда
    minSpreadPct := s.getConfigValue(ctx, "min_spread_pct", 0.001) // мин 0.1%
    marketAdjustment := s.getConfigValue(ctx, "market_adjustment", 0.8) // сила привязки к рынку (0-1)

    // Корректируем spreadMultiplier в зависимости от тренда
    switch trend {
    case "bullish":
        skewFactor = math.Abs(skewFactor) // смещаемся вверх
    case "bearish":
        skewFactor = -math.Abs(skewFactor) // смещаемся вниз
    }

    // Ограничиваем спред
    if spreadPct > maxSpreadPct {
        spreadPct = maxSpreadPct
        log.Printf("[ConservativeMM] Спред ограничен до %.4f%%", maxSpreadPct*100)
    }
    if spreadPct < minSpreadPct {
        spreadPct = minSpreadPct
        log.Printf("[ConservativeMM] Спред увеличен до минимума %.4f%%", minSpreadPct*100)
    }

    // Привязываем fairPrice к текущей рыночной цене
    // marketAdjustment = 0.0 - не привязываем, 1.0 - полностью привязываем
    adjustedFairPrice := fairPrice*(1-marketAdjustment) + currentPrice*marketAdjustment
    
    log.Printf("[ConservativeMM] Параметры: levels=%d, base_size=%.4f, spread_multiplier=%.2f, trend=%s, привязка=%.1f",
        levels, baseSize, spreadMultiplier, trend, marketAdjustment*100)
    log.Printf("[ConservativeMM] Цены: рынок=%.2f, fair=%.2f, adjusted=%.2f",
        currentPrice, fairPrice, adjustedFairPrice)

    ordersPlaced := 0
    pairID := snapshot.PairID
    symbol := snapshot.MarketData.Symbol

    for level := 1; level <= levels; level++ {
        // Рассчитываем спред для текущего уровня
        levelSpread := spreadPct * spreadMultiplier * float64(level)

        // Добавляем смещение из-за тренда на более высоких уровнях
        trendAdjustment := skewFactor * float64(level-1) / float64(levels)

        // Рассчитываем цены со смещением
        buyPrice := adjustedFairPrice * (1 - levelSpread + trendAdjustment)
        sellPrice := adjustedFairPrice * (1 + levelSpread + trendAdjustment)

        // Дополнительная коррекция к рынку для далеких ордеров
        // Чем дальше от рынка, тем сильнее корректируем
        distanceFromMarket := (buyPrice - currentPrice) / currentPrice
        if math.Abs(distanceFromMarket) > 0.05 { // Если >5% от рынка
            correctionFactor := 0.5 // Корректируем на 50%
            if buyPrice < currentPrice {
                buyPrice = buyPrice*(1-correctionFactor) + currentPrice*correctionFactor
            }
            if sellPrice > currentPrice {
                sellPrice = sellPrice*(1-correctionFactor) + currentPrice*correctionFactor
            }
            log.Printf("[ConservativeMM] Уровень %d: коррекция цен к рынку (расстояние %.2f%%)", 
                level, distanceFromMarket*100)
        }

        // Округляем цены
        buyPrice = s.roundPrice(buyPrice, symbol)
        sellPrice = s.roundPrice(sellPrice, symbol)

        // Проверяем, чтобы цены были разумными
        if !s.validatePrice(buyPrice, sellPrice, currentPrice, adjustedFairPrice) {
            log.Printf("[ConservativeMM] Пропуск уровня %d из-за неразумных цен", level)
            continue
        }

        // Корректируем объем в зависимости от расстояния от цены
        size := s.adjustVolume(baseSize, level, levelSpread, buyPrice, sellPrice, currentPrice)

        // BUY ордер
        if s.placeOrder(ctx, pairID, symbol, "buy", buyPrice, size, level) {
            ordersPlaced++
        }

        // SELL ордер
        if s.placeOrder(ctx, pairID, symbol, "sell", sellPrice, size, level) {
            ordersPlaced++
        }

        log.Printf("[ConservativeMM] Уровень %d: BUY @ %g (от рынка: %.4f%%) | SELL @ %g (от рынка: %.4f%%) | qty %.4f",
            level, buyPrice, (buyPrice-currentPrice)/currentPrice*100,
            sellPrice, (sellPrice-currentPrice)/currentPrice*100, size)
    }

    log.Printf("[ConservativeMM] Всего размещено ордеров: %d (тренд: %s)", ordersPlaced, trend)
}

func (s *ConservativeMarketMaker) getConfigValue(ctx *models.BotContext, key string, defaultValue float64) float64 {
    if val, ok := ctx.Config.Parameters[key]; ok {
        if f, ok := val.(float64); ok {
            return f
        }
    }
    return defaultValue
}


func (s *ConservativeMarketMaker) placeOrder(ctx *models.BotContext, pairID int, symbol string, side string, price float64, quantity float64, level int) bool {
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
        Priority:          level,
        Remarks:           fmt.Sprintf("Conservative MM L%d", level),
    }
    if _, err := s.orderManager.SaveOrder(orderData); err != nil {
        log.Printf("[ConservativeMM] Ошибка сохранения ордера %s @ %.2f: %v", side, price, err)
        return false
    }
    log.Printf("[ConservativeMM] Размещен ордер %s %s %.4f @ %g (уровень %d)",
        side, symbol, quantity, price, level)
    return true
}

func (s *ConservativeMarketMaker) roundPrice(price float64, symbol string) float64 {
    // Определяем количество знаков после запятой по цене
    var decimals int
    if price >= 1000 {
        decimals = 0
    } else if price >= 100 {
        decimals = 1
    } else if price >= 1 {
        decimals = 2
    } else if price >= 0.01 {
        decimals = 4
    } else if price >= 0.0001 {
        decimals = 6
    } else {
        decimals = 8
    }
    multiplier := math.Pow10(decimals)
    return math.Round(price*multiplier) / multiplier
}

func (s *ConservativeMarketMaker) validatePrice(buyPrice, sellPrice, currentPrice, fairPrice float64) bool {
    // Цены должны быть положительными
    if buyPrice <= 0 || sellPrice <= 0 {
        log.Printf("[ConservativeMM] Цены не положительные: buy=%.2f, sell=%.2f", buyPrice, sellPrice)
        return false
    }

    // Цена покупки должна быть меньше цены продажи
    if buyPrice >= sellPrice {
        log.Printf("[ConservativeMM] Buy >= Sell: buy=%.2f, sell=%.2f", buyPrice, sellPrice)
        return false
    }

    // Проверяем спред
    calculatedSpread := (sellPrice - buyPrice) / ((buyPrice + sellPrice) / 2)
    if calculatedSpread > 0.1 { // спред больше 10% неразумный
        log.Printf("[ConservativeMM] Слишком большой спред: %.2f%%", calculatedSpread*100)
        return false
    }
    if calculatedSpread < 0.0005 { // спред меньше 0.05% неразумный
        log.Printf("[ConservativeMM] Слишком маленький спред: %.4f%%", calculatedSpread*100)
        return false
    }

    // Цены не должны отклоняться слишком сильно от рынка
    maxDeviationFromMarket := currentPrice * 0.15 // максимум 15% отклонения от рынка
    if math.Abs(buyPrice - currentPrice) > maxDeviationFromMarket {
        log.Printf("[ConservativeMM] BUY слишком далеко от рынка: %.2f vs %.2f (разница %.2f%%)",
            buyPrice, currentPrice, (buyPrice-currentPrice)/currentPrice*100)
        return false
    }
    if math.Abs(sellPrice - currentPrice) > maxDeviationFromMarket {
        log.Printf("[ConservativeMM] SELL слишком далеко от рынка: %.2f vs %.2f (разница %.2f%%)",
            sellPrice, currentPrice, (sellPrice-currentPrice)/currentPrice*100)
        return false
    }

    // Цены должны быть разумными относительно друг друга
    if sellPrice/buyPrice > 1.2 { // Продажа не должна быть >20% дороже покупки
        log.Printf("[ConservativeMM] SELL/BUY ratio слишком большой: %.2f", sellPrice/buyPrice)
        return false
    }

    return true
}

func (s *ConservativeMarketMaker) adjustVolume(baseSize float64, level int, levelSpread float64, 
    buyPrice, sellPrice, currentPrice float64) float64 {
    // Базовое уменьшение объема на более высоких уровнях
    volumeReduction := 1.0 / float64(level)
    
    // Дополнительное уменьшение при большом спреде
    if levelSpread > 0.01 {
        volumeReduction *= 0.8
    }
    
    // Уменьшаем объем для слишком далеких от рынка ордеров
    buyDistance := math.Abs(buyPrice - currentPrice) / currentPrice
    sellDistance := math.Abs(sellPrice - currentPrice) / currentPrice
    avgDistance := (buyDistance + sellDistance) / 2
    
    if avgDistance > 0.05 { // Если среднее расстояние >5%
        distancePenalty := 1.0 - (avgDistance - 0.05) * 10 // Уменьшаем объем пропорционально
        if distancePenalty < 0.3 {
            distancePenalty = 0.3 // Минимум 30% объема
        }
        volumeReduction *= distancePenalty
    }
    
    // Минимальный объем
    minSize := baseSize * 0.05 // Минимум 5% от базового объема
    size := baseSize * volumeReduction
    if size < minSize {
        size = minSize
    }
    
    return size
}

func (s *ConservativeMarketMaker) ValidateConfig(config map[string]interface{}) error {
    required := []string{"pair_id", "symbol"}
    for _, key := range required {
        if _, ok := config[key]; !ok {
            return fmt.Errorf("%s is required", key)
        }
    }
    
    // Проверяем допустимые значения
    if levels, ok := config["levels"]; ok {
        if f, ok := levels.(float64); ok {
            if f < 1 || f > 10 {
                return fmt.Errorf("levels must be between 1 and 10")
            }
        }
    }
    
    return nil
}

func (s *ConservativeMarketMaker) CalculateMetrics(ctx *models.BotContext) map[string]interface{} {
    return map[string]interface{}{
        "strategy": "Conservative Market Maker",
        "version":  "2.0",
        "last_mid_price": s.lastMidPrice,
    }
}

// checkOrderExecution проверяет исполнение активных ордеров
func (s *ConservativeMarketMaker) checkOrderExecution(ctx *models.BotContext, currentPrice float64) {
    // Получаем активные ордера этого бота
    activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
    if err != nil {
        log.Printf("[ConservativeMM] Ошибка получения активных ордеров: %v", err)
        return
    }
    if len(activeOrders) == 0 {
        return
    }
    log.Printf("[ConservativeMM] Проверка исполнения %d активных ордеров (рынок: %.2f)", 
        len(activeOrders), currentPrice)
    executedCount := 0
    for _, ord := range activeOrders {
        shouldExecute := false
        switch ord.Side {
        case "buy":
            shouldExecute = currentPrice <= ord.Price
        case "sell":
            shouldExecute = currentPrice >= ord.Price
        }
        if shouldExecute {
            if s.executeOrder(ctx, ord, currentPrice) {
                executedCount++
                log.Printf("[ConservativeMM] Ордер %s @ %.2f исполнен по цене %.2f", 
                    ord.OrderID, ord.Price, currentPrice)
            }
        }
    }
    if executedCount > 0 {
        log.Printf("[ConservativeMM] Исполнено ордеров: %d", executedCount)
    }
}

func (s *ConservativeMarketMaker) recordTradeMetrics(ord *models.Order, executionPrice float64) {
    tradeValue := executionPrice * ord.Quantity
    log.Printf("[ConservativeMM]  Сделка: %s %.4f @ %.2f = %.2f", 
        ord.Side, ord.Quantity, executionPrice, tradeValue)
    
    // Можно добавить запись в таблицу метрик или статистики
}
// updateOrderStatus обновляет статус ордера
func (s *ConservativeMarketMaker) updateOrderStatus(ord *models.Order) error {
    // Проверьте, какой метод доступен в вашем orderManager
    // Возможные варианты:
    
    // 1. Если есть метод UpdateOrder
    if manager, ok := s.orderManager.(interface {
        UpdateOrder(ord *models.Order) error
    }); ok {
        return manager.UpdateOrder(ord)
    }
    
    // 2. Если есть метод UpdateOrderStatus
    if manager, ok := s.orderManager.(interface {
        UpdateOrderStatus(orderID string, status string, executedPrice float64) error
    }); ok {
        return manager.UpdateOrderStatus(ord.OrderID, "filled", ord.Price)
    }
    
    // 3. Если ничего не подходит, просто логируем
    log.Printf("[ConservativeMM] Обновление ордера %s -> filled", ord.OrderID)
    return nil
}

// checkPartialExecution проверяет частичное исполнение
func (s *ConservativeMarketMaker) checkPartialExecution(ctx *models.BotContext, orderBook *market.OrderBook) {
    activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
    if err != nil {
        return
    }

    for _, order := range activeOrders {
        // Проверяем, есть ли наш ордер в стакане (частичное исполнение)
        if s.isInOrderBook(order, orderBook) {
            s.handlePartialExecution(order, orderBook)
        }
    }
}

// isInOrderBook проверяет, находится ли ордер в стакане
func (s *ConservativeMarketMaker) isInOrderBook(order *models.Order, orderBook *market.OrderBook) bool {
    if orderBook == nil {
        return false
    }
    
    switch order.Side {
    case "buy":
        for _, bid := range orderBook.Bids {
            if math.Abs(bid.Price - order.Price) < 0.01 {
                return true
            }
        }
    case "sell":
        for _, ask := range orderBook.Asks {
            if math.Abs(ask.Price - order.Price) < 0.01 {
                return true
            }
        }
    }
    return false
}


// checkPartialExecution проверяет частичное исполнение (заглушка)
/*
func (s *ConservativeMarketMaker) checkPartialExecution(ctx *models.BotContext, orderBook *market.OrderBook) {
    // Временная заглушка
    // log.Printf("[ConservativeMM] Проверка частичного исполнения (реализовать позже)")
}
*/
// isInOrderBook проверяет, находится ли ордер в стакане (заглушка)
/*
func (s *ConservativeMarketMaker) isInOrderBook(order order.OrderData, orderBook *market.OrderBook) bool {
    // Временная заглушка
    return false
}
*/
// handlePartialExecution обрабатывает частичное исполнение (заглушка)
func (s *ConservativeMarketMaker) handlePartialExecution(order *models.Order, orderBook *market.OrderBook) {
    // Временная заглушка
    // log.Printf("[ConservativeMM] Частичное исполнение (реализовать позже)")
}
func (s *ConservativeMarketMaker) calculatePnL(ctx *models.BotContext) {
    var filledOrders []*models.Order
    
    // Группируем по сделкам (покупаем дешевле, продаем дороже)
    var totalBuyValue, totalSellValue, totalFees float64
    var buyCount, sellCount int
    
    for _, order := range filledOrders {
        if order.Status != "filled" {
            continue
        }
        
        orderValue := order.Price * order.Quantity
        
        if order.Side == "buy" {
            totalBuyValue += orderValue
            buyCount++
        } else if order.Side == "sell" {
            totalSellValue += orderValue
            sellCount++
        }
        
        totalFees += 0 // Fee not tracked in this version
    }
    
    grossProfit := totalSellValue - totalBuyValue
    netProfit := grossProfit - totalFees
    profitPercentage := 0.0
    if totalBuyValue > 0 {
        profitPercentage = (netProfit / totalBuyValue) * 100
    }
    
    log.Printf("[ConservativeMM]  P&L: покупки=%d (%.2f), продажи=%d (%.2f)", 
        buyCount, totalBuyValue, sellCount, totalSellValue)
    log.Printf("[ConservativeMM]  Прибыль: валовая=%.2f, чистая=%.2f, комиссии=%.2f, доходность=%.2f%%",
        grossProfit, netProfit, totalFees, profitPercentage)
}
func (s *ConservativeMarketMaker) getOrderTTL(level int, spreadPct float64) time.Duration {
    // Базовое время жизни
    baseTTL := 15 * time.Minute
    
    // Корректировка по уровню
    ttl := baseTTL * time.Duration(level)
    
    // Корректировка по спреду (больший спред = дольше жизнь)
    if spreadPct > 0.01 {
        ttl = ttl * 2
    }
    
    // Ограничения
    minTTL := 5 * time.Minute
    maxTTL := 60 * time.Minute
    
    if ttl < minTTL {
        ttl = minTTL
    }
    if ttl > maxTTL {
        ttl = maxTTL
    }
    
    return ttl
}
