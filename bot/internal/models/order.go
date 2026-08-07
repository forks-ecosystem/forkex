// internal/models/order.go
package models

import (
    "time"
)

type Order struct {
    BotID int `json:"bot_id" db:"bot_id"`
    BotUserID int
    ConfigID int
    CreatedAt time.Time `json:"created_at" db:"created_at"`
    DistancePct float64
    ExecutedAt time.Time
    ExecutedPrice float64
    FilledQuantity float64
    FilledValue float64
    ID int `json:"id" db:"id"`
    OrderID string `json:"order_id" db:"order_id"`
    PairID int `json:"pair_id" db:"pair_id"`
    Price float64 `json:"price" db:"price"`
    Priority int
    Quantity float64
    Remarks string
    Side string `json:"side" db:"side"`
    Size float64 `json:"size" db:"size"`
    Status string `json:"status" db:"status"`
    Symbol string `json:"symbol" db:"symbol"`
    Type string // "limit", "market"
    UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
    UserID int `json:"user_id" db:"user_id"`
}