// internal/models/bot_user.go
package models

import (
    "encoding/json"
    "time"
)

type BotUser struct {
    ID                         int       `json:"id" db:"id"`
    Name                       string    `json:"name" db:"name"`
    Description                string    `json:"description" db:"description"`
    OwnerID                    int       `json:"owner_id" db:"owner_id"`
    BotType                    string    `json:"bot_type" db:"bot_type"`
    Config                     JSONB     `json:"config" db:"config"`
    RiskLevel                  string    `json:"risk_level" db:"risk_level"`
    MaxDailyLoss               float64   `json:"max_daily_loss" db:"max_daily_loss"`
    MaxPositionSize            float64   `json:"max_position_size" db:"max_position_size"`
    IsActive                   bool      `json:"is_active" db:"is_active"`
    IsTesting                  bool      `json:"is_testing" db:"is_testing"`
    Exchange                   string    `json:"exchange" db:"exchange"`
    TradingPairs               []string  `json:"trading_pairs" db:"trading_pairs"`
    StrategySettings           JSONB     `json:"strategy_settings" db:"strategy_settings"`
    PerformanceMetrics         JSONB     `json:"performance_metrics" db:"performance_metrics"`
    APICredentials             JSONB     `json:"api_credentials" db:"api_credentials"`
    TradingHours               JSONB     `json:"trading_hours" db:"trading_hours"`
    MarketConditions           JSONB     `json:"market_conditions" db:"market_conditions"`
    RiskParameters             JSONB     `json:"risk_parameters" db:"risk_parameters"`
    NotificationSettings       JSONB     `json:"notification_settings" db:"notification_settings"`
    CapitalAllocation          JSONB     `json:"capital_allocation" db:"capital_allocation"`
    BacktestingResults         JSONB     `json:"backtesting_results" db:"backtesting_results"`
    OperationalStatus          JSONB     `json:"operational_status" db:"operational_status"`
    LicenseAndPermissions      JSONB     `json:"license_and_permissions" db:"license_and_permissions"`
    OptimizationSettings       JSONB     `json:"optimization_settings" db:"optimization_settings"`
    VersionInfo                JSONB     `json:"version_info" db:"version_info"`
    Tags                       []string  `json:"tags" db:"tags"`
    IsPublic                   bool      `json:"is_public" db:"is_public"`
    PublicPerformanceVisible   bool      `json:"public_performance_visible" db:"public_performance_visible"`
    CopyTradingEnabled         bool      `json:"copy_trading_enabled" db:"copy_trading_enabled"`
    MaxCopyTraders             int       `json:"max_copy_traders" db:"max_copy_traders"`
    CopyTradingFeePercentage   float64   `json:"copy_trading_fee_percentage" db:"copy_trading_fee_percentage"`
    MinimumInvestment          float64   `json:"minimum_investment" db:"minimum_investment"`
    MaximumInvestment          float64   `json:"maximum_investment" db:"maximum_investment"`
    AutoRestart                bool      `json:"auto_restart" db:"auto_restart"`
    RestartDelayMinutes        int       `json:"restart_delay_minutes" db:"restart_delay_minutes"`
    LoggingLevel               string    `json:"logging_level" db:"logging_level"`
    DataRetentionDays          int       `json:"data_retention_days" db:"data_retention_days"`
    LastTradeExecuted          time.Time `json:"last_trade_executed" db:"last_trade_executed"`
    NextScheduledAction        time.Time `json:"next_scheduled_action" db:"next_scheduled_action"`
    TelegramBotToken           string    `json:"telegram_bot_token" db:"telegram_bot_token"`
    DashboardURL               string    `json:"dashboard_url" db:"dashboard_url"`
    CustomWebhookHeaders       JSONB     `json:"custom_webhook_headers" db:"custom_webhook_headers"`
    PerformanceFeePercentage   float64   `json:"performance_fee_percentage" db:"performance_fee_percentage"`
    ManagementFeePercentage    float64   `json:"management_fee_percentage" db:"management_fee_percentage"`
    FeeCollectionInterval      string    `json:"fee_collection_interval" db:"fee_collection_interval"`
    TaxSettings                JSONB     `json:"tax_settings" db:"tax_settings"`
    AIFeatures                 JSONB     `json:"ai_features" db:"ai_features"`
    ComplianceSettings         JSONB     `json:"compliance_settings" db:"compliance_settings"`
    BackupSettings             JSONB     `json:"backup_settings" db:"backup_settings"`
    CreatedAt                  time.Time `json:"created_at" db:"created_at"`
    UpdatedAt                  time.Time `json:"updated_at" db:"updated_at"`
}

// Метод для сканирования массива строк из БД
func (bu *BotUser) ScanTradingPairs(value interface{}) error {
    if value == nil {
        bu.TradingPairs = []string{}
        return nil
    }
    
    // Пробуем разные варианты декодирования
    switch v := value.(type) {
    case []byte:
        return json.Unmarshal(v, &bu.TradingPairs)
    case string:
        return json.Unmarshal([]byte(v), &bu.TradingPairs)
    case []string:
        bu.TradingPairs = v
        return nil
    default:
        return json.Unmarshal([]byte{}, &bu.TradingPairs)
    }
}

// Метод для сканирования массива тегов из БД
func (bu *BotUser) ScanTags(value interface{}) error {
    if value == nil {
        bu.Tags = []string{}
        return nil
    }
    
    switch v := value.(type) {
    case []byte:
        return json.Unmarshal(v, &bu.Tags)
    case string:
        return json.Unmarshal([]byte(v), &bu.Tags)
    case []string:
        bu.Tags = v
        return nil
    default:
        return json.Unmarshal([]byte{}, &bu.Tags)
    }
}

// Value методы для преобразования в формат БД
func (bu BotUser) ValueTradingPairs() (interface{}, error) {
    return json.Marshal(bu.TradingPairs)
}

func (bu BotUser) ValueTags() (interface{}, error) {
    return json.Marshal(bu.Tags)
}

// Создадим функцию для получения настроек по умолчанию
func DefaultBotUser() *BotUser {
    return &BotUser{
        BotType:                  "market_maker",
        RiskLevel:                "medium",
        MaxDailyLoss:             1000.00,
        MaxPositionSize:          0.0,
        IsActive:                 true,
        IsTesting:                false,
        Exchange:                 "binance",
        TradingPairs:             []string{"BTCUSDT"},
        StrategySettings:         JSONB{"algorithm": "grid", "grid_levels": 5},
        PerformanceMetrics:       JSONB{"total_pnl": 0.0},
        APICredentials:           JSONB{"encrypted": true},
        TradingHours:             JSONB{"timezone": "UTC"},
        MarketConditions:         JSONB{"min_volume": 100000},
        RiskParameters:           JSONB{"max_concurrent_trades": 3},
        NotificationSettings:     JSONB{"channels": []string{"email"}},
        CapitalAllocation:        JSONB{"initial_capital": 1000.0},
        BacktestingResults:       JSONB{"backtest_period": "30d"},
        OperationalStatus:        JSONB{"health_status": "healthy"},
        LicenseAndPermissions:    JSONB{"license_type": "standard"},
        OptimizationSettings:     JSONB{"auto_optimize": false},
        VersionInfo:              JSONB{"bot_version": "1.0.0"},
        Tags:                     []string{},
        IsPublic:                 false,
        PublicPerformanceVisible: false,
        CopyTradingEnabled:       false,
        MaxCopyTraders:           0,
        CopyTradingFeePercentage: 0.0,
        MinimumInvestment:        0.0,
        MaximumInvestment:        0.0,
        AutoRestart:              true,
        RestartDelayMinutes:      5,
        LoggingLevel:             "info",
        DataRetentionDays:        30,
        CustomWebhookHeaders:     JSONB{},
        PerformanceFeePercentage: 20.0,
        ManagementFeePercentage:  2.0,
        FeeCollectionInterval:    "monthly",
        TaxSettings:              JSONB{"tax_percentage": 0.0},
        AIFeatures:               JSONB{"uses_ml": false},
        ComplianceSettings:       JSONB{"kyc_required": true},
        BackupSettings:           JSONB{"auto_backup": true},
    }
}
