package strategies

import (
    "github.com/ixbaseANT/bot/internal/market/data"
    "github.com/ixbaseANT/bot/internal/bot/order"
    "github.com/ixbaseANT/bot/internal/models"

    conservative_mm "github.com/ixbaseANT/bot/internal/bot/strategies/conservative_mm"
    grid_trading "github.com/ixbaseANT/bot/internal/bot/strategies/grid_trading"
)

type cmmOrderManager struct {
    inner order.OrderManager
}

func (c *cmmOrderManager) SaveOrder(orderData order.OrderData) (string, error) {
    return c.inner.SaveOrder(orderData)
}

func (c *cmmOrderManager) GetActiveOrders(configID int) ([]*models.Order, error) {
    orders, err := c.inner.GetActiveOrders(configID)
    if err != nil {
        return nil, err
    }
    result := make([]*models.Order, len(orders))
    for i, o := range orders {
        result[i] = &models.Order{
            OrderID:   o.OrderID,
            Side:      o.Side,
            Price:     o.Price,
            Quantity:  o.Quantity,
            Status:    o.Status,
            CreatedAt: o.CreatedAt,
        }
    }
    return result, nil
}

func (c *cmmOrderManager) RemoveActiveOrder(orderID string) error {
    return c.inner.CancelOrder(orderID)
}

func (c *cmmOrderManager) UpdateOrderStatus(orderID, status string, executedPrice float64) error {
    return c.inner.UpdateOrderStatus(orderID, status, executedPrice)
}

// Factory создает стратегии
type Factory struct{}

func NewFactory() *Factory { return &Factory{}}

// NewConservativeMarketMaker creates a conservative market maker
func (f *Factory) NewConservativeMarketMaker(
    marketProvider data.MarketDataProvider,
    orderManager order.OrderManager,
) *conservative_mm.ConservativeMarketMaker {
    return conservative_mm.NewConservativeMarketMaker(
        marketProvider,
        &cmmOrderManager{inner: orderManager},
    )
}
/*
// NewMarketMakerClassic создает классического маркет-мейкера
func (f *Factory) NewMarketMakerClassic(
    marketProvider data.Provider,
    orderManager order.Manager,
) *market_maker.MarketMakerClassic {
    return market_maker.NewMarketMakerClassic(marketProvider, orderManager)
}
*/
// NewGridTrading creates a grid trading strategy
func (f *Factory) NewGridTrading(
    marketProvider data.MarketDataProvider,
    orderManager order.OrderManager,
) *grid_trading.GridTrading {
    return grid_trading.NewGridTrading(marketProvider, orderManager)
}
/*
// NewTrendFollowing создает стратегию следования тренду
func (f *Factory) NewTrendFollowing(
    marketProvider data.Provider,
    orderManager order.Manager,
) *trend_following.TrendFollowing {
    return trend_following.NewTrendFollowing(marketProvider, orderManager)
}

// NewArbitrage создает арбитражную стратегию
func (f *Factory) NewArbitrage(
    marketProvider data.Provider,
    orderManager order.Manager,
) *arbitrage.Arbitrage {
    return arbitrage.NewArbitrage(marketProvider, orderManager)
}

*/