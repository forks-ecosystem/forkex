// internal/bot/strategies/conservative_mm/smart_placement.go
package conservative_mm

import (
    "math"
    "github.com/ixbaseANT/bot/internal/market"
    "github.com/ixbaseANT/bot/internal/models"
)

func (s *ConservativeMarketMaker) placeSmartOrders(
    ctx *models.BotContext, 
    snapshot *market.MarketSnapshot,
    conditions *MarketConditions,
) {
    pairID, symbol, _ := s.getConfigParams(ctx)
    currentPrice := snapshot.MarketData.CurrentPrice
    
    // Получаем текущие позиции
    position := s.GetPosition(ctx.ConfigID)
    
    // Рассчитываем количество уровней
    levels := int(s.getConfigValue(ctx, "levels", 5))
    
    // Получаем базовый размер ордера
    baseSize := s.getConfigValue(ctx, "order_size", 0.01)
    
    // Используем рекомендуемые размеры из анализа
    buySize := baseSize
    sellSize := baseSize
    if conditions != nil && conditions.RecommendedSizes != nil {
        if size, ok := conditions.RecommendedSizes["buy"]; ok {
            buySize = size
        }
        if size, ok := conditions.RecommendedSizes["sell"]; ok {
            sellSize = size
        }
    }
    
    // Корректируем на текущую позицию (инвентарный контроль)
    maxPosition := s.getConfigValue(ctx, "max_position", 1.0)
    positionRatio := position.BaseBalance / maxPosition
    
    // Если у нас уже много базовой валюты, уменьшаем покупки
    if positionRatio > 0.7 {
        buySize *= (1 - positionRatio)
    }
    // Если у нас мало базовой валюты, уменьшаем продажи
    if positionRatio < 0.3 && positionRatio > 0 {
        sellSize *= positionRatio * 2
    }
    
    // Размещаем ордера с учетом анализа
    for i := 1; i <= levels; i++ {
        // Рассчитываем спред для уровня
        levelSpread := s.calculateLevelSpread(conditions, i, levels)
        
        // Рассчитываем цены
        bidPrice := currentPrice * (1 - levelSpread)
        askPrice := currentPrice * (1 + levelSpread)
        
        // Корректируем цены относительно уровней поддержки/сопротивления
        if conditions != nil {
            bidPrice = s.adjustPriceToSupport(bidPrice, conditions.SupportLevels, true)
            askPrice = s.adjustPriceToResistance(askPrice, conditions.ResistanceLevels, false)
        }
        
        // Рассчитываем размер для уровня (уменьшается с удалением от цены)
        levelSizeFactor := 1.0 - float64(i-1)*0.15
        if levelSizeFactor < 0.3 {
            levelSizeFactor = 0.3
        }
        
        // Размещаем buy ордер
        if positionRatio < 0.9 { // Не покупаем, если почти достигли максимума
            s.placeOrder(ctx, pairID, symbol, "buy", 
                bidPrice, 
                buySize*levelSizeFactor,
                i)
        }
        
        // Размещаем sell ордер
        // Всегда размещаем ордера на продажу для двустороннего рынка
        s.placeOrder(ctx, pairID, symbol, "sell", 
            askPrice, 
            sellSize*levelSizeFactor,
            i)
    }
}

func (s *ConservativeMarketMaker) calculateLevelSpread(
    conditions *MarketConditions, 
    level, totalLevels int,
) float64 {
    baseSpread := 0.001 // 0.1%
    
    if conditions != nil {
        baseSpread = conditions.RecommendedSpread
    }
    
    // Увеличиваем спред для дальних уровней
    levelFactor := 1.0 + float64(level-1)*0.5
    
    // Добавляем случайную составляющую для избежания скопления ордеров
    randomFactor := 0.9 + s.rand.Float64()*0.2
    
    return baseSpread * levelFactor * randomFactor
}

func (s *ConservativeMarketMaker) adjustPriceToSupport(
    price float64, 
    supports []float64,
    isBuy bool,
) float64 {
    if len(supports) == 0 {
        return price
    }
    
    // Находим ближайший уровень поддержки
    closestSupport := 0.0
    minDistance := math.MaxFloat64
    
    for _, support := range supports {
        distance := math.Abs(price - support)
        if distance < minDistance && distance < price*0.01 { // В пределах 1%
            minDistance = distance
            closestSupport = support
        }
    }
    
    if closestSupport > 0 {
        if isBuy {
            // Для buy ордеров стараемся ставить чуть выше поддержки
            if price < closestSupport {
                return closestSupport * 1.001
            }
        }
    }
    
    return price
}

func (s *ConservativeMarketMaker) adjustPriceToResistance(
    price float64, 
    resistances []float64,
    isSell bool,
) float64 {
    if len(resistances) == 0 {
        return price
    }
    
    closestResistance := 0.0
    minDistance := math.MaxFloat64
    
    for _, resistance := range resistances {
        distance := math.Abs(price - resistance)
        if distance < minDistance && distance < price*0.01 {
            minDistance = distance
            closestResistance = resistance
        }
    }
    
    if closestResistance > 0 {
        if isSell {
            // Для sell ордеров стараемся ставить чуть ниже сопротивления
            if price > closestResistance {
                return closestResistance * 0.999
            }
        }
    }
    
    return price
}
