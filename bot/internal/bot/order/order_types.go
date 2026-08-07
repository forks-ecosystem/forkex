package order

import (
    "time"
)

// OrderData - полная модель ордера для сохранения в БД
type OrderData struct {
    // Основные поля из таблицы orders
    ID              int       `json:"id"`
    UserID          int       `json:"user_id"`
    PairID          int       `json:"pair_id"`
    BotID           int       `json:"bot_id"`
    ConfigID        int       `json:"config_id"`
    BotUserID       int       `json:"bot_user_id"`
    
    // Торговые параметры
    Symbol          string    `json:"symbol"`
    Side            string    `json:"side"`            // "buy", "sell"
    Type            string    `json:"type"`            // "limit", "market", "instant"
    Price           float64   `json:"price"`
    Quantity        float64   `json:"quantity"`
    Size            float64   `json:"size"`            // alias для quantity для совместимости
    
    // Статус и исполнение
    Status          string    `json:"status"`          // "pending", "open", "filled", "canceled"
    Accepted        bool      `json:"accepted"`
    AcceptedAmount  float64   `json:"accepted_amount"`
    Fee             float64   `json:"fee"`
    
    // Идентификаторы
    OrderID         string    `json:"order_id"`
    
    // Стратегия и параметры исполнения
    ExecutionStrategy string  `json:"execution_strategy"`
    ExecutionParams  map[string]interface{} `json:"execution_params"`
    
    // Дополнительные параметры из нового дизайна
    Priority        int       `json:"priority"`
    DistancePct     float64   `json:"distance_pct"`
    Remarks         string    `json:"remarks"`
    
    // Временные метки
    CreatedAt       time.Time `json:"created_at"`
    UpdatedAt       time.Time `json:"updated_at"`
    FilledAt        time.Time `json:"filled_at"`
    CancelledAt     time.Time `json:"cancelled_at"`
}

// OrderRequest - запрос на создание ордера
type OrderRequest struct {
    ConfigID        int
    BotUserID       int
    PairID          int
    Symbol          string
    Side            string
    Type            string
    Price           float64
    Quantity        float64
    Strategy        string
    Priority        int
    DistancePct     float64
    Remarks         string
}

// ToOrderData конвертирует запрос в OrderData
func (r *OrderRequest) ToOrderData() OrderData {
    now := time.Now()
    return OrderData{
        ConfigID:          r.ConfigID,
        BotUserID:        r.BotUserID,
        PairID:           r.PairID,
        UserID:           r.BotUserID, // Для совместимости
        Symbol:           r.Symbol,
        Side:             r.Side,
        Type:             r.Type,
        Price:            r.Price,
        Quantity:         r.Quantity,
        Size:             r.Quantity, // Дублируем для совместимости
        Status:           "pending",
        Accepted:         false,
        AcceptedAmount:   0,
        Fee:              0,
        ExecutionStrategy: r.Strategy,
        ExecutionParams:  make(map[string]interface{}),
        Priority:         r.Priority,
        DistancePct:      r.DistancePct,
        Remarks:          r.Remarks,
        CreatedAt:        now,
        UpdatedAt:        now,
    }
}
