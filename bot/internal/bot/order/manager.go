package order

// OrderManager интерфейс для работы с ордерами
type OrderManager interface {
    SaveOrder(order OrderData) (string, error)
    SaveOrderFromRequest(req OrderRequest) (string, error)
    GetOrderByID(orderID string) (*OrderData, error)
    GetActiveOrders(configID int) ([]OrderData, error)
    GetOrdersByConfig(configID int, limit int) ([]OrderData, error)
    UpdateOrderStatus(orderID, status string, executedPrice float64) error
    UpdateOrder(order OrderData) error
    GetFilledOrders(configID int) ([]OrderData, error)

    CancelOrder(orderID string) error
    CancelOldOrders(configID int, maxAgeMinutes int) (int, error)
    CancelOldOrdersByStrategy(strategy string, maxAgeMinutes int) (int, error)

    MatchMarketableOrder(orderData OrderData, ioc bool) (*MatchResult, error)
}
/*
    // Существующие методы
    SaveOrder(orderData OrderData) (OrderData, error)
    GetActiveOrders(configID int) ([]OrderData, error) // возвращает слайс
    CancelOrder(orderID string) error
    
    // Исправленный метод - должен возвращать слайс
    GetFilledOrders(configID int) ([]OrderData, error) // []OrderData вместо OrderData
    
    UpdateOrderStatus(orderID string, status string, executedPrice float64) error
*/
