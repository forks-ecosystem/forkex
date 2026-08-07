// internal/strategy/factory.go
package strategy

import (
    "github.com/ixbaseANT/bot/internal/models"
)

type Strategy interface {
    Name() string
    CalculateOrders(data interface{}) ([]models.Order, error)
    UpdateConfig(params map[string]interface{})
    GetMetrics() map[string]interface{}
    Initialize(pairs []models.BotPair)
}

func NewStrategy(strategyType string, pairs []models.BotPair) Strategy {
    switch strategyType {
    case "market_maker":
        strat := NewMarketMaker(pairs)
        strat.Initialize(pairs)
        return strat
    case "arbitrage":
        strat := NewArbitrage(pairs)
        strat.Initialize(pairs)
        return strat
    case "trend_following":
        strat := NewTrendFollowing(pairs)
        strat.Initialize(pairs)
        return strat
    default:
        return nil
    }
}
