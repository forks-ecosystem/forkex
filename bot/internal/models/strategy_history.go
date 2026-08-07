// internal/models/strategy_history.go
package models

import "time"

type StrategyEvent string

const (
    EventCreated        StrategyEvent = "Created"
    EventStarted        StrategyEvent = "Started"
    EventPaused         StrategyEvent = "Paused"
    EventResumed        StrategyEvent = "Resumed"
    EventStopped        StrategyEvent = "Stopped"
    EventSignal         StrategyEvent = "Signal"
    EventOrderCreated   StrategyEvent = "OrderCreated"
    EventOrderFilled    StrategyEvent = "OrderFilled"
    EventOrderCanceled  StrategyEvent = "OrderCanceled"
    EventPositionOpened StrategyEvent = "PositionOpened"
    EventPositionClosed StrategyEvent = "PositionClosed"
    EventRiskTriggered  StrategyEvent = "RiskTriggered"
    EventError          StrategyEvent = "Error"
    EventCompleted      StrategyEvent = "Completed"
)

type StrategyHistory struct {
    ID         int            `json:"id" db:"id"`
    StrategyID int            `json:"strategy_id" db:"strategy_id"`
    BotUserID  int            `json:"bot_user_id" db:"bot_user_id"`
    Version    string         `json:"version" db:"version"`
    SessionID  string         `json:"session_id" db:"session_id"`
    Timestamp  time.Time      `json:"timestamp" db:"timestamp"`
    Event      StrategyEvent  `json:"event" db:"event"`
    State      string         `json:"state" db:"state"`
    Symbol     string         `json:"symbol" db:"symbol"`
    Timeframe  string         `json:"timeframe" db:"timeframe"`
    Price      float64        `json:"price" db:"price"`
    Volume     float64        `json:"volume" db:"volume"`
    Signal     string         `json:"signal" db:"signal"`
    Action     string         `json:"action" db:"action"`
    OrderID    string         `json:"order_id" db:"order_id"`
    PositionID string         `json:"position_id" db:"position_id"`
    Result     string         `json:"result" db:"result"`
    PnL        float64        `json:"pnl" db:"pnl"`
    Context    map[string]any `json:"context" db:"context"`
    Comment    string         `json:"comment" db:"comment"`
    CreatedBy  string         `json:"created_by" db:"created_by"`
    CreatedAt  time.Time      `json:"created_at" db:"created_at"`
}
