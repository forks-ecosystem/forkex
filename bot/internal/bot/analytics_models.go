package bot

import (
    "time"
)

// BacktestResults - результаты бэктестинга
type BacktestResults struct {
    ID              int                     `json:"id"`
    BotConfigID     int                     `json:"bot_config_id"`
    StrategyName    string                  `json:"strategy_name"`
    TradingPair     string                  `json:"trading_pair"`
    Timeframe       string                  `json:"timeframe"`
    StartDate       time.Time               `json:"start_date"`
    EndDate         time.Time               `json:"end_date"`
    InitialCapital  float64                 `json:"initial_capital"`
    FinalCapital    float64                 `json:"final_capital"`
    TotalReturn     float64                 `json:"total_return"`
    AnnualReturn    float64                 `json:"annual_return"`
    SharpeRatio     float64                 `json:"sharpe_ratio"`
    MaxDrawdown     float64                 `json:"max_drawdown"`
    WinRate         float64                 `json:"win_rate"`
    TotalTrades     int                     `json:"total_trades"`
    ProfitableTrades int                    `json:"profitable_trades"`
    LossMakingTrades int                    `json:"loss_making_trades"`
    AvgProfit       float64                 `json:"avg_profit"`
    AvgLoss         float64                 `json:"avg_loss"`
    ProfitFactor    float64                 `json:"profit_factor"`
    RecoveryFactor  float64                 `json:"recovery_factor"`
    Expectancy      float64                 `json:"expectancy"`
    PerformanceMetrics map[string]float64   `json:"performance_metrics"`
    EquityCurve     []EquityPoint           `json:"equity_curve"`
    TradeHistory    []TradeRecord           `json:"trade_history"`
    Parameters      map[string]interface{}  `json:"parameters"`
    CreatedAt       time.Time               `json:"created_at"`
    Status          string                  `json:"status"` // "completed", "failed", "running"
    ErrorMessage    string                  `json:"error_message,omitempty"`
}

// EquityPoint - точка на кривой капитала
type EquityPoint struct {
    Timestamp time.Time `json:"timestamp"`
    Equity    float64   `json:"equity"`
    Balance   float64   `json:"balance"`
}

// TradeRecord - запись о сделке
type TradeRecord struct {
    ID            int       `json:"id"`
    Timestamp     time.Time `json:"timestamp"`
    Type          string    `json:"type"` // "buy", "sell"
    EntryPrice    float64   `json:"entry_price"`
    ExitPrice     float64   `json:"exit_price"`
    Quantity      float64   `json:"quantity"`
    Profit        float64   `json:"profit"`
    ProfitPercent float64   `json:"profit_percent"`
    Duration      int64     `json:"duration"` // в секундах
    Commission    float64   `json:"commission"`
    Slippage      float64   `json:"slippage"`
    Reason        string    `json:"reason"`   // "stop_loss", "take_profit", "signal"
    Status        string    `json:"status"`   // "filled", "canceled", "rejected"
}

// StrategyComparison - сравнение стратегий
type StrategyComparison struct {
    ID                int                     `json:"id"`
    ComparisonName    string                  `json:"comparison_name"`
    Description       string                  `json:"description"`
    Strategies        []StrategyComparisonItem `json:"strategies"`
    Metrics           map[string]float64      `json:"metrics"`
    BestPerformer     string                  `json:"best_performer"`
    WorstPerformer    string                  `json:"worst_performer"`
    CreatedAt         time.Time               `json:"created_at"`
}

// StrategyComparisonItem - элемент сравнения стратегий
type StrategyComparisonItem struct {
    StrategyName    string                 `json:"strategy_name"`
    ConfigID        int                    `json:"config_id"`
    TotalReturn     float64                `json:"total_return"`
    SharpeRatio     float64                `json:"sharpe_ratio"`
    MaxDrawdown     float64                `json:"max_drawdown"`
    WinRate         float64                `json:"win_rate"`
    TotalTrades     int                    `json:"total_trades"`
    ProfitFactor    float64                `json:"profit_factor"`
    Parameters      map[string]interface{} `json:"parameters"`
    Rank            int                    `json:"rank"`
}

// PerformanceReport - отчет о производительности
type PerformanceReport struct {
    ID              int                     `json:"id"`
    BotConfigID     int                     `json:"bot_config_id"`
    ReportType      string                  `json:"report_type"` // "daily", "weekly", "monthly", "custom"
    PeriodStart     time.Time               `json:"period_start"`
    PeriodEnd       time.Time               `json:"period_end"`
    TotalProfit     float64                 `json:"total_profit"`
    TotalVolume     float64                 `json:"total_volume"`
    TotalTrades     int                     `json:"total_trades"`
    AvgTradeSize    float64                 `json:"avg_trade_size"`
    AvgHoldingTime  int64                   `json:"avg_holding_time"`
    WinRate         float64                 `json:"win_rate"`
    ProfitFactor    float64                 `json:"profit_factor"`
    MaxConsecutiveWins int                  `json:"max_consecutive_wins"`
    MaxConsecutiveLosses int                `json:"max_consecutive_losses"`
    DailyReturns    []DailyReturn           `json:"daily_returns"`
    RiskMetrics     RiskMetrics             `json:"risk_metrics"`
    CreatedAt       time.Time               `json:"created_at"`
}

// DailyReturn - дневная доходность
type DailyReturn struct {
    Date   time.Time `json:"date"`
    Return float64   `json:"return"`
    Profit float64   `json:"profit"`
    Volume float64   `json:"volume"`
    Trades int       `json:"trades"`
}

// RiskMetrics - метрики риска
type RiskMetrics struct {
    Volatility       float64 `json:"volatility"`
    ValueAtRisk95    float64 `json:"var_95"`
    ExpectedShortfall float64 `json:"expected_shortfall"`
    Beta             float64 `json:"beta"`
    Alpha            float64 `json:"alpha"`
    SortinoRatio     float64 `json:"sortino_ratio"`
    CalmarRatio      float64 `json:"calmar_ratio"`
}

// AnalyticsConfig - конфигурация аналитики
type AnalyticsConfig struct {
    SaveBacktestResults bool   `json:"save_backtest_results"`
    AutoGenerateReports bool   `json:"auto_generate_reports"`
    ReportSchedule      string `json:"report_schedule"` // "daily", "weekly", "monthly"
    DataRetentionDays   int    `json:"data_retention_days"`
    EnableRealTimeStats bool   `json:"enable_real_time_stats"`
}

