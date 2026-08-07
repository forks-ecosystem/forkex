package strategy

import "github.com/ixbaseANT/bot/internal/models"

type TradingStrategy interface {
    CalculateOrders(midPrice float64) ([]models.Order, error)
    Name() string
    UpdateConfig(params map[string]interface{})
    GetMetrics() map[string]interface{}
}
