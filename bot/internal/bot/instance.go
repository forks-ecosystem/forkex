package bot

import (
    "context"
    "fmt"
    "log"
    "sync"
    "time"
    "github.com/ixbaseANT/bot/internal/models"
    "github.com/ixbaseANT/bot/internal/database"
    "github.com/ixbaseANT/bot/internal/repository"
    "github.com/ixbaseANT/bot/internal/bot/strategies"  
)

// BotInstance представляет работающий бот
type BotInstance struct {
    data    *BotInstanceData
    mu      sync.RWMutex
}
type BotInstanceData struct {
    Config      *models.BotConfig
    Strategy    strategies.Strategy
    DB          database.Database
    Stats       models.BotStats
    Info        models.BotInfo
    IsRunning   bool
    StopChan    chan struct{}
    LastError   string
    LastSuccess time.Time
    History     *repository.StrategyHistoryRepository
    SessionID   string
}
// NewBotInstance создает новый экземпляр бота
func NewBotInstance(configID, 
    botUserID int, 
    config *models.BotConfig, 
    strategy strategies.Strategy, 
    db Database,
    history *repository.StrategyHistoryRepository,
    sessionID string) (*BotInstance, error) {
    // Получаем торговую пару из параметров
    tradingPair := ""
    if symbol, ok := config.Parameters["symbol"]; ok {
        tradingPair = symbol.(string)
    }
    // Получаем режим исполнения
    executionMode := "standard"
    if mode, ok := config.Parameters["execution_mode"]; ok {
        executionMode = mode.(string)
    }
    // Получаем уровень риска
    riskLevel := "medium"
    if level, ok := config.Parameters["risk_level"]; ok {
        riskLevel = level.(string)
    }
    log.Printf("==== Bot tradingPair %s, executionMode %s, riskLevel %s",
        tradingPair, executionMode, riskLevel)
    log.Printf("==== Bot strategy: %s ", strategy)
    now := time.Now()
    
    b := &BotInstance{
        data: &BotInstanceData{
            Config: config,
            Strategy: strategy,
            DB: db,
            Stats: models.BotStats{
                ConfigID:      configID,
                BotUserID:     botUserID,
                BotName:       config.Name,
                Strategy:      strategy.GetName(),
                IsActive:      false,
                ActiveTime:    0,
                TotalOrders:   0,
                FilledOrders:  0,
                CanceledOrders: 0,
                TotalVolume:   0,
                TotalProfit:   0,
                CurrentEquity: 1000, // Начальный капитал
                MaxDrawdown:   0,
                WinRate:       0,
                LastUpdated:   now,
                StartedAt:     now,
                LastTradeTime: time.Time{},
            },
            Info: models.BotInfo{
                ConfigID:      configID,
                BotUserID:     botUserID,
                BotName:       config.Name,
                StrategyName:  strategy.GetName(),
                StrategyCode:  strategy.GetCodeName(),
                IsActive:      false,
                TradingPair:   tradingPair,
                ExecutionMode: executionMode,
                RiskLevel:     riskLevel,
                Status:        "stopped",
                Uptime:        "0s",
                Performance: map[string]interface{}{
                    "daily_profit":   0.0,
                    "weekly_profit":  0.0,
                    "monthly_profit": 0.0,
                    "sharpe_ratio":   0.0,
                },
            },
            IsRunning:   false,
            StopChan:    make(chan struct{}),
            LastError:   "",
            LastSuccess: time.Time{},
            History:     history,
            SessionID:   sessionID,
        },
    }
    b.recordEvent(models.EventCreated, func(e *models.StrategyHistory) {
        e.State = "created"
    })
    return b, nil
}

// Start запускает бота
func (b *BotInstance) Start() error {
    b.mu.Lock()
    defer b.mu.Unlock()
    if b.data.IsRunning {
        return nil // Уже запущен
    }
    b.data.IsRunning = true
    b.data.Stats.IsActive = true
    b.data.Stats.StartedAt = time.Now()
    b.data.Info.IsActive = true
    b.data.Info.Status = "running"
    b.data.StopChan = make(chan struct{})
    // Запускаем в горутине
    b.recordEvent(models.EventStarted, func(e *models.StrategyHistory) {
        e.State = "running"
    })
    go b.run()
    log.Printf("!!!) Bot %d ('%s') started successfully",
        b.data.Config.ID, b.data.Config.Name)
    return nil
}

// run основной цикл работы бота
func (b *BotInstance) run() {
    // Настраиваем интервал обновления из конфигурации
    updateInterval := 5 * time.Second // значение по умолчанию
    if updateRate, ok := b.data.Config.Strategy.Settings["update_rate"]; ok {
        if rate, ok := updateRate.(float64); ok {
            updateInterval = time.Duration(rate) * time.Second
        }
    }
    ticker := time.NewTicker(updateInterval)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            b.executeCycle()
        case <-b.data.StopChan:
            b.onStop()
            return
        }
    }
}

// executeCycle выполняет один цикл торговли
func (b *BotInstance) executeCycle() {
    defer func() {
        if r := recover(); r != nil {
            log.Printf("❌ CYCLE PANIC (bot %d): %v", b.data.Config.ID, r)
        }
    }()
    b.mu.Lock()
    defer b.mu.Unlock()
    // Обновляем время активности
    uptime := time.Since(b.data.Stats.StartedAt)
    b.data.Stats.ActiveTime = int64(uptime.Seconds())
    b.data.Stats.LastUpdated = time.Now()
    b.data.Info.Uptime = formatDuration(uptime)
    b.data.LastSuccess = time.Now()
    // Создаем контекст для стратегии
    ctx := &models.BotContext{
        ConfigID:  b.data.Config.ID,
        BotUserID: b.data.Config.BotUserID,
        Config:    b.data.Config,
        DB:        b.data.DB,
        IsActive:  b.data.IsRunning,
        StopChan:  b.data.StopChan,
        Stats:     &b.data.Stats,
    }
    log.Printf("222) executeCycle   %v",b.data.Strategy)
    // Выполняем стратегию
    if err := b.data.Strategy.Execute(ctx); err != nil {
        b.data.LastError = err.Error()
        log.Printf("Error executing strategy for bot %d: %v", 
            b.data.Config.ID, err)
        b.recordEvent(models.EventError, func(e *models.StrategyHistory) {
            e.State = "error"
            e.Result = "failed"
            e.Comment = err.Error()
        })
    }
    // Обновляем метрики производительности
    b.updatePerformanceMetrics()
}

// onStop обработка остановки бота
func (b *BotInstance) onStop() {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.data.IsRunning = false
    b.data.Stats.IsActive = false
    b.data.Info.IsActive = false
    b.data.Info.Status = "stopped"

    b.recordEvent(models.EventStopped, func(e *models.StrategyHistory) {
        e.State = "stopped"
        e.Result = "completed"
    })

    log.Printf("Bot %d ('%s') stopped", 
        b.data.Config.ID, b.data.Config.Name)
}

// Stop останавливает бота
func (b *BotInstance) Stop() error {
    b.mu.Lock()
    defer b.mu.Unlock()

    if !b.data.IsRunning {
        return nil // Уже остановлен
    }

    close(b.data.StopChan)
    b.data.IsRunning = false
    
    return nil
}

// updatePerformanceMetrics обновляет метрики производительности
func (b *BotInstance) updatePerformanceMetrics() {
    // Рассчитываем win rate
    if b.data.Stats.FilledOrders > 0 {
        b.data.Stats.WinRate = float64(b.data.Stats.FilledOrders-b.data.Stats.CanceledOrders) / 
            float64(b.data.Stats.FilledOrders) * 100
    }

    // Обновляем performance в Info
    b.data.Info.Performance = b.data.Strategy.CalculateMetrics(&models.BotContext{
        Config: b.data.Config,
        Stats:  &b.data.Stats,
    })
}

// GetStats возвращает статистику бота
func (b *BotInstance) GetStats() models.BotStats {
    b.mu.RLock()
    defer b.mu.RUnlock()
    return b.data.Stats
}

// GetInfo возвращает информацию о боте
func (b *BotInstance) GetInfo() map[string]interface{} {
    b.mu.RLock()
    defer b.mu.RUnlock()
    
    return map[string]interface{}{
        "config_id":      b.data.Info.ConfigID,
        "bot_user_id":    b.data.Info.BotUserID,
        "bot_name":       b.data.Info.BotName,
        "strategy_name":  b.data.Info.StrategyName,
        "strategy_code":  b.data.Info.StrategyCode,
        "is_active":      b.data.Info.IsActive,
        "trading_pair":   b.data.Info.TradingPair,
        "execution_mode": b.data.Info.ExecutionMode,
        "risk_level":     b.data.Info.RiskLevel,
        "status":         b.data.Info.Status,
        "uptime":         b.data.Info.Uptime,
        "last_error":     b.data.LastError,
        "last_success":   b.data.LastSuccess.Format(time.RFC3339),
    }
}

// IsActive проверяет активен ли бот
func (b *BotInstance) IsActive() bool {
    b.mu.RLock()
    defer b.mu.RUnlock()
    return b.data.IsRunning
}

// symbol возвращает торговую пару из параметров конфигурации
func (b *BotInstance) symbol() string {
    if s, ok := b.data.Config.Parameters["symbol"]; ok {
        if str, ok := s.(string); ok {
            return str
        }
    }
    return ""
}

// timeframe возвращает таймфрейм из параметров конфигурации
func (b *BotInstance) timeframe() string {
    if s, ok := b.data.Config.Parameters["timeframe"]; ok {
        if str, ok := s.(string); ok {
            return str
        }
    }
    return ""
}

// recordEvent записывает событие в журнал стратегий (не фатально при ошибке)
func (b *BotInstance) recordEvent(event models.StrategyEvent, opts ...func(*models.StrategyHistory)) {
    h := b.data.History
    if h == nil {
        return
    }
    e := models.StrategyHistory{
        StrategyID: b.data.Config.ID,
        BotUserID:  b.data.Config.BotUserID,
        Version:    b.data.Config.Strategy.Version,
        SessionID:  b.data.SessionID,
        Event:      event,
        Symbol:     b.symbol(),
        Timeframe:  b.timeframe(),
        CreatedBy:  "bot",
    }
    for _, o := range opts {
        o(&e)
    }
    ctx := context.Background()
    if err := h.RecordEvent(ctx, e); err != nil {
        log.Printf("Failed to record strategy event %s for bot %d: %v",
            event, b.data.Config.ID, err)
    }
}

// formatDuration форматирует время в читаемый вид
func formatDuration(d time.Duration) string {    days := int(d.Hours() / 24)
    hours := int(d.Hours()) % 24
    minutes := int(d.Minutes()) % 60
    seconds := int(d.Seconds()) % 60
    
    if days > 0 {
        return fmt.Sprintf("%dd %dh %dm %ds", days, hours, minutes, seconds)
    }
    if hours > 0 {
        return fmt.Sprintf("%dh %dm %ds", hours, minutes, seconds)
    }
    if minutes > 0 {
        return fmt.Sprintf("%dm %ds", minutes, seconds)
    }
    return fmt.Sprintf("%ds", seconds)
}
