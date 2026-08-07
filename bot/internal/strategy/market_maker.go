// internal/strategy/market_maker.go
package strategy

import (
    "fmt"
    "math/rand"
    "sync"

    "github.com/ixbaseANT/bot/internal/models"
)

type MarketMakerStrategy struct {
    pairs  []models.BotPair
    mu     sync.Mutex
    orders map[string]string // orderID -> side
}

func (s *MarketMakerStrategy) Initialize(pairs []models.BotPair) {
    s.pairs = pairs
    s.orders = make(map[string]string)
}

func NewMarketMaker(pairs []models.BotPair) *MarketMakerStrategy {
    return &MarketMakerStrategy{
        pairs:  pairs,
        orders: make(map[string]string),
    }
}

func (m *MarketMakerStrategy) CalculateOrders(data interface{}) ([]models.Order, error) {
    strategyData, ok := data.(StrategyData)
    if !ok {
        return nil, fmt.Errorf("invalid data type for market maker strategy")
    }
    
    m.mu.Lock()
    defer m.mu.Unlock()

    var orders []models.Order
    
    // Используем midPrice из данных
    midPrice := strategyData.MidPrice
    
    // Обрабатываем все пары
    for _, pair := range m.pairs {
        // Получаем настройки из конфигурации пары
        settings := pair.GetMarketMakerSettings()
        
        spread := settings.Spread
        if spread <= 0 {
            spread = 0.5 // 0.5% по умолчанию
        }

        levels := settings.Levels
        if levels <= 0 {
            levels = 3 // по умолчанию 3 уровня
        }

        orderSize := settings.OrderSize
        if orderSize <= 0 {
            orderSize = 0.01 // по умолчанию
        }

        for i := 1; i <= levels; i++ {
            levelSpread := spread * float64(i) / 100.0 // переводим % в долю

            // Bid order (покупка)
            bidPrice := midPrice * (1 - levelSpread)
            bidSize := orderSize * (0.8 + rand.Float64()*0.4)

            orders = append(orders, models.Order{
                UserID:  pair.BotID,
                Symbol:  pair.Symbol,
                Side:    "buy",
                Price:   bidPrice,
                Size:    bidSize,
                Status:  "open",
            })

            // Ask order (продажа)
            askPrice := midPrice * (1 + levelSpread)
            askSize := orderSize * (0.8 + rand.Float64()*0.4)

            orders = append(orders, models.Order{
                UserID:  pair.BotID,
                Symbol:  pair.Symbol,
                Side:    "sell",
                Price:   askPrice,
                Size:    askSize,
                Status:  "open",
            })
        }
    }

    return orders, nil
}

func (m *MarketMakerStrategy) Name() string {
    return "market_maker"
}

func (m *MarketMakerStrategy) UpdateConfig(params map[string]interface{}) {
    m.mu.Lock()
    defer m.mu.Unlock()
    
    // Обновляем настройки для всех пар
    for i := range m.pairs {
        if spread, ok := params["spread"].(float64); ok {
            m.pairs[i].UpdateMarketMakerSetting("spread", spread)
        }
        if levels, ok := params["levels"].(float64); ok {
            m.pairs[i].UpdateMarketMakerSetting("levels", int(levels))
        }
        if orderSize, ok := params["order_size"].(float64); ok {
            m.pairs[i].UpdateMarketMakerSetting("order_size", orderSize)
        }
    }
}

func (m *MarketMakerStrategy) GetMetrics() map[string]interface{} {
    m.mu.Lock()
    defer m.mu.Unlock()
    
    metrics := map[string]interface{}{
        "active_orders": len(m.orders),
        "total_pairs":   len(m.pairs),
    }
    
    // Добавляем метрики по каждой паре
    for _, pair := range m.pairs {
        settings := pair.GetMarketMakerSettings()
        metrics[pair.Symbol] = map[string]interface{}{
            "spread":     settings.Spread,
            "levels":     settings.Levels,
            "order_size": settings.OrderSize,
        }
    }
    
    return metrics
}
