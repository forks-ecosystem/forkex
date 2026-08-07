// internal/bot/strategies/conservative_mm/execution.go
package conservative_mm

import (
    "log"
    "sort"

    "github.com/ixbaseANT/bot/internal/market"
    "github.com/ixbaseANT/bot/internal/market/data"
    "github.com/ixbaseANT/bot/internal/models"
//    "github.com/ixbaseANT/bot/internal/bot/order"
//    "github.com/ixbaseANT/bot/internal/repository"
)

type OrderExecutor struct {
    orderRepo     OrderRepository
    statsRepo     StatsRepository
    marketProvider data.MarketDataProvider
}

// sortOrdersByPrice сортирует ордера по цене
func (s *ConservativeMarketMaker) sortOrdersByPrice(orders []*models.Order) (buyOrders, sellOrders []*models.Order) {
    for _, order := range orders {
        if order.Side == "buy" {
            buyOrders = append(buyOrders, order)
        } else {
            sellOrders = append(sellOrders, order)
        }
    }
    
    // Сортируем buy от высоких к низким
    sort.Slice(buyOrders, func(i, j int) bool {
        return buyOrders[i].Price > buyOrders[j].Price
    })
    
    // Сортируем sell от низких к высоким
    sort.Slice(sellOrders, func(i, j int) bool {
        return sellOrders[i].Price < sellOrders[j].Price
    })
    
    return buyOrders, sellOrders
}

// checkExecutionWithOrderBook проверяет исполнение ордеров по стакану
func (s *ConservativeMarketMaker) checkExecutionWithOrderBook(ctx *models.BotContext, snapshot *market.MarketSnapshot) {
    activeOrders, err := s.orderManager.GetActiveOrders(ctx.ConfigID)
    if err != nil {
        log.Printf("[ConservativeMM] Ошибка получения активных ордеров: %v", err)
        return
    }
    
    if len(activeOrders) == 0 {
        return
    }
    
    log.Printf("[ConservativeMM] Проверка исполнения со стаканом, %d ордеров", len(activeOrders))
    
    if snapshot == nil {
        log.Printf("[ConservativeMM] Нет данных, пропускаем проверку")
        return
    }
    
    if snapshot.OrderBook == nil {
        // Если нет стакана, используем простую проверку
        s.checkOrderExecution(ctx, snapshot.MarketData.CurrentPrice)
        return
    }
    
    // Сортируем ордера по цене
    buyOrders, sellOrders := s.sortOrdersByPrice(activeOrders)
    
    // Проверяем buy ордера против ask стакана
    executed := s.checkBuyOrdersAgainstAsks(ctx, buyOrders, snapshot.OrderBook.Asks)
    
    // Проверяем sell ордера против bid стакана
    executed += s.checkSellOrdersAgainstBids(ctx, sellOrders, snapshot.OrderBook.Bids)
    
    if executed > 0 {
        log.Printf("[ConservativeMM] Исполнено ордеров по стакану: %d", executed)
    }
}

// checkBuyOrdersAgainstAsks проверяет buy ордера против ask стакана
func (s *ConservativeMarketMaker) checkBuyOrdersAgainstAsks(
    ctx *models.BotContext,
    buyOrders []*models.Order,
    asks []market.PriceLevel,
) int {
    if len(buyOrders) == 0 || len(asks) == 0 {
        return 0
    }
    
    executed := 0
    askIndex := 0
    
    for _, order := range buyOrders {
        if askIndex >= len(asks) {
            break
        }
        
        // Проверяем, может ли ордер быть исполнен по текущим ask ценам
        for askIndex < len(asks) && asks[askIndex].Price <= order.Price {
            if s.executeOrder(ctx, order, asks[askIndex].Price) {
                executed++
                log.Printf("[ConservativeMM] Buy ордер %s исполнен по ask %.2f",
                    order.OrderID, asks[askIndex].Price)
            }
            askIndex++
            break // В реальной системе здесь нужна более сложная логика
        }
    }
    
    return executed
}

// checkSellOrdersAgainstBids проверяет sell ордера против bid стакана
func (s *ConservativeMarketMaker) checkSellOrdersAgainstBids(
    ctx *models.BotContext,
    sellOrders []*models.Order,
    bids []market.PriceLevel,
) int {
    if len(sellOrders) == 0 || len(bids) == 0 {
        return 0
    }
    
    executed := 0
    bidIndex := 0
    
    for _, order := range sellOrders {
        if bidIndex >= len(bids) {
            break
        }
        
        for bidIndex < len(bids) && bids[bidIndex].Price >= order.Price {
            if s.executeOrder(ctx, order, bids[bidIndex].Price) {
                executed++
                log.Printf("[ConservativeMM] Sell ордер %s исполнен по bid %.2f",
                    order.OrderID, bids[bidIndex].Price)
            }
            bidIndex++
            break
        }
    }
    
    return executed
}

// executeOrder исполняет ордер
func (s *ConservativeMarketMaker) executeOrder(ctx *models.BotContext, ord *models.Order, executionPrice float64) bool {
	log.Printf("[ConservativeMM] Исполнение ордера %s (%s) по цене %.2f",
		ord.OrderID, ord.Side, executionPrice)

	// Обновляем позицию
	s.updatePosition(ctx, ord, executionPrice)

	// Помечаем ордер исполненным в БД (запись OrderFilled + сделка)
	if err := s.orderManager.UpdateOrderStatus(ord.OrderID, "filled", executionPrice); err != nil {
		log.Printf("[ConservativeMM] Ошибка обновления статуса ордера %s: %v", ord.OrderID, err)
		return false
	}

	log.Printf("[ConservativeMM] Ордер %s исполнен, объем: %.4f @ %.2f",
		ord.OrderID, ord.Quantity, executionPrice)

	return true
}

// updatePosition обновляет текущую позицию
func (s *ConservativeMarketMaker) updatePosition(ctx *models.BotContext, ord *models.Order, executionPrice float64) {
    position := s.GetPosition(ctx.ConfigID)
    
    if ord.Side == "buy" {
        position.BaseBalance += ord.Quantity
        position.QuoteBalance -= ord.Quantity * executionPrice
    } else {
        position.BaseBalance -= ord.Quantity
        position.QuoteBalance += ord.Quantity * executionPrice
    }
    
    s.SetPosition(ctx.ConfigID, position)
    
    log.Printf("[ConservativeMM] Позиция обновлена: Base=%.6f, Quote=%.2f",
        position.BaseBalance, position.QuoteBalance)
}
