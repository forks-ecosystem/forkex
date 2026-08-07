// internal/strategy/trend_following.go
package strategy

import (
    "fmt"
    "sync"

    "github.com/ixbaseANT/bot/internal/models"
)

type TrendFollowingStrategy struct {
    pairs []models.BotPair
    mu    sync.Mutex
}

func (s *TrendFollowingStrategy) Initialize(pairs []models.BotPair) {
    s.pairs = pairs
}

func NewTrendFollowing(pairs []models.BotPair) *TrendFollowingStrategy {
    return &TrendFollowingStrategy{
        pairs: pairs,
    }
}

func (t *TrendFollowingStrategy) CalculateOrders(data interface{}) ([]models.Order, error) {
    strategyData, ok := data.(StrategyData)
    if !ok {
        return nil, fmt.Errorf("invalid data type for trend following strategy")
    }
    
    t.mu.Lock()
    defer t.mu.Unlock()

    var orders []models.Order
    indicators := strategyData.Indicators
    
    // Логика следования тренду
    // Пример: если RSI < 30 - покупаем, если RSI > 70 - продаем
    
    for _, pair := range t.pairs {
        // Получаем индикаторы для данной пары
        rsiKey := pair.Symbol + "_rsi"
        maKey := pair.Symbol + "_ma"
        fmt.Sprintf("maKey %s", maKey)
        if rsi, exists := indicators[rsiKey]; exists {
            // Пример стратегии по RSI
            if rsi < 30 {
                // Перепроданность - сигнал к покупке
                orders = append(orders, models.Order{
                    UserID:  pair.BotID,
                    Symbol:  pair.Symbol,
                    Side:    "buy",
                    Price:   strategyData.MidPrice * 0.99, // на 1% ниже mid price
                    Size:    0.01,
                    Status:  "open",
                })
            } else if rsi > 70 {
                // Перекупленность - сигнал к продаже
                orders = append(orders, models.Order{
                    UserID:  pair.BotID,
                    Symbol:  pair.Symbol,
                    Side:    "sell",
                    Price:   strategyData.MidPrice * 1.01, // на 1% выше mid price
                    Size:    0.01,
                    Status:  "open",
                })
            }
        }
    }
    
    return orders, nil
}

func (t *TrendFollowingStrategy) Name() string {
    return "trend_following"
}

func (t *TrendFollowingStrategy) UpdateConfig(params map[string]interface{}) {
    t.mu.Lock()
    defer t.mu.Unlock()
    
    // Обновление конфигурации следования тренду
    // Например, параметры индикаторов, уровни перекупленности/перепроданности
}

func (t *TrendFollowingStrategy) GetMetrics() map[string]interface{} {
    t.mu.Lock()
    defer t.mu.Unlock()
    
    metrics := map[string]interface{}{
        "strategy": "trend_following",
        "pairs":    len(t.pairs),
    }
    
    // Добавляем информацию о парах
    var pairSymbols []string
    for _, pair := range t.pairs {
        pairSymbols = append(pairSymbols, pair.Symbol)
    }
    metrics["pair_symbols"] = pairSymbols
    
    return metrics
}
