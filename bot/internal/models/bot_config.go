// internal/models/bot_config.go
package models

import (
    "time"
    "github.com/ixbaseANT/bot/internal/database"
)

// Определяем интерфейс Strategy
type Strategy interface {
    GetName() string
    GetCodeName() string
    Execute(ctx *BotContext) error
    ValidateConfig(config map[string]interface{}) error
    CalculateMetrics(ctx *BotContext) map[string]interface{}
}

// StrategyConfig конфигурация стратегии
type StrategyConfig struct {
    CodeName string                 `json:"code_name" db:"code_name"`
    Name     string                 `json:"name" db:"name"`
    Version  string                 `json:"version" db:"version"`
    Settings map[string]interface{} `json:"settings" db:"settings"` // Changed from JSONB
    Params   map[string]interface{} `json:"params,omitempty"`
}

type BotConfig struct {
    ID         int                    `json:"id" db:"id"`
    Name       string                 `json:"name" db:"name"`
    BotUserID  int                    `json:"bot_user_id" db:"bot_user_id"`
    Config     *BotConfig
    DB         database.Database   
    Strategy   StrategyConfig         `json:"strategy" db:"strategy"`
    Parameters map[string]interface{} `json:"parameters" db:"parameters"` // Changed from JSONB
    IsActive   bool                   `json:"is_active" db:"is_active"`
    StopChan   chan struct{}
    Stats      *BotStats
    CreatedAt  time.Time              `json:"created_at" db:"created_at"`
    UpdatedAt  time.Time              `json:"updated_at" db:"updated_at"`
}

// BotContext контекст для стратегии

type BotContext struct {
    ConfigID   int
    BotUserID  int
    PairID     int
    Config     *BotConfig
    DB         database.Database
    IsActive   bool
    StopChan   chan struct{}
    Stats      *BotStats
}

// BotConfig конфигурация бота
/*
type BotConfig struct {
    ID         int
    Name       string
    BotUserID  int
    Strategy   StrategyConfig
    Parameters map[string]interface{}
}
*/
// BotStats статистика бота
type BotStats struct {
    ConfigID       int       `json:"config_id"`
    BotUserID      int       `json:"bot_user_id"`
    BotName        string    `json:"bot_name"`
    Strategy       string    `json:"strategy"`
    IsActive       bool      `json:"is_active"`
    ActiveTime     int64     `json:"active_time"`      // в секундах
    TotalOrders    int       `json:"total_orders"`
    FilledOrders   int       `json:"filled_orders"`
    CanceledOrders int       `json:"canceled_orders"`
    TotalVolume    float64   `json:"total_volume"`
    TotalProfit    float64   `json:"total_profit"`
    CurrentEquity  float64   `json:"current_equity"`
    MaxDrawdown    float64   `json:"max_drawdown"`
    WinRate        float64   `json:"win_rate"`
    LastUpdated    time.Time `json:"last_updated"`
    StartedAt      time.Time `json:"started_at"`
    LastTradeTime  time.Time `json:"last_trade_time"`
}
// BotInfo - информация о боте для отображения
type BotInfo struct {
    ConfigID      int                    `json:"config_id"`
    BotUserID     int                    `json:"bot_user_id"`
    BotName       string                 `json:"bot_name"`
    StrategyName  string                 `json:"strategy_name"`
    StrategyCode  string                 `json:"strategy_code"`
    IsActive      bool                   `json:"is_active"`
    TradingPair   string                 `json:"trading_pair"`
    ExecutionMode string                 `json:"execution_mode"`
    RiskLevel     string                 `json:"risk_level"`
    Status        string                 `json:"status"`
    Uptime        string                 `json:"uptime"`
    Performance   map[string]interface{} `json:"performance"`
}
