// internal/strategy/arbitrage.go
package strategy

import (
    "fmt"
    "sync"

    "github.com/ixbaseANT/bot/internal/models"
)

type ArbitrageStrategy struct {
    pairs []models.BotPair
    mu    sync.Mutex
}

func (s *ArbitrageStrategy) Initialize(pairs []models.BotPair) {
    s.pairs = pairs
}

func NewArbitrage(pairs []models.BotPair) *ArbitrageStrategy {
    return &ArbitrageStrategy{
        pairs: pairs,
    }
}

func (a *ArbitrageStrategy) CalculateOrders(data interface{}) ([]models.Order, error) {
    strategyData, ok := data.(StrategyData)
    if !ok {
        return nil, fmt.Errorf("invalid data type for arbitrage strategy")
    }
    
    a.mu.Lock()
    defer a.mu.Unlock()

    var orders []models.Order
    prices := strategyData.Prices
    
    // Логика арбитража
    // Пример: треугольный арбитраж между парами
    if len(a.pairs) >= 3 && len(prices) >= 3 {
        // Простая логика для демонстрации
        // В реальности здесь будет сложный алгоритм арбитража
        
        for _, pair := range a.pairs {
            if price, exists := prices[pair.Symbol]; exists {
                // Пример: если цена отклоняется больше чем на 1%, создаем ордер
                // Это упрощенный пример, реальная логика будет сложнее
                fmt.Sprintf("price %d", price)
                // Здесь должна быть сложная логика арбитража
                // Например, поиск несоответствий между связанными парами
            }
        }
    }
    
    return orders, nil
}

func (a *ArbitrageStrategy) Name() string {
    return "arbitrage"
}

func (a *ArbitrageStrategy) UpdateConfig(params map[string]interface{}) {
    a.mu.Lock()
    defer a.mu.Unlock()
    
    // Обновление конфигурации арбитража
    // Например, минимальный процент прибыли, максимальное время выполнения и т.д.
}

func (a *ArbitrageStrategy) GetMetrics() map[string]interface{} {
    a.mu.Lock()
    defer a.mu.Unlock()
    
    metrics := map[string]interface{}{
        "strategy": "arbitrage",
        "pairs":    len(a.pairs),
    }
    
    // Добавляем информацию о парах
    var pairSymbols []string
    for _, pair := range a.pairs {
        pairSymbols = append(pairSymbols, pair.Symbol)
    }
    metrics["pair_symbols"] = pairSymbols
    
    return metrics
}
