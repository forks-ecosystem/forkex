package bot

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "sync"

    "github.com/ixbaseANT/bot/internal/market/data"
    "github.com/ixbaseANT/bot/internal/bot/order"
    "github.com/ixbaseANT/bot/internal/bot/strategies"
//    "github.com/ixbaseANT/bot/internal/bot/strategies/conservative_mm"

    "github.com/ixbaseANT/bot/internal/config"
    "github.com/ixbaseANT/bot/internal/models"
    "github.com/ixbaseANT/bot/internal/database"
    "github.com/ixbaseANT/bot/internal/repository"
    "github.com/google/uuid"
    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgconn"
)

type Querier interface {
    Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
    Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
    QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Pinger interface {
    Ping(ctx context.Context) error
}

type Closer interface {
    Close()
}

// Database  основной интерфейс, который внедряется в репозитории
type Database interface {
    Querier
    Pinger
    Closer
}

// Rows интерфейс для работы с результатами запроса
type Rows interface {
    Next() bool
    Scan(dest ...interface{}) error
    Err() error
    Close() error
//    Columns() ([]string, error)
}

// Row интерфейс для работы с одной строкой
type Row interface {
    Scan(dest ...interface{}) error
}

// orderHistoryRecorder адаптирует журнал стратегий под recorder ордеров конкретного бота
type orderHistoryRecorder struct {
    repo      *repository.StrategyHistoryRepository
    configID  int
    botUserID int
    version   string
    sessionID string
}

func (r *orderHistoryRecorder) RecordEvent(ctx context.Context, event models.StrategyHistory) error {
    event.StrategyID = r.configID
    event.BotUserID = r.botUserID
    event.Version = r.version
    event.SessionID = r.sessionID
    return r.repo.RecordEvent(ctx, event)
}

// BotManager управляет всеми ботами
type BotManager struct {
    cfg        *config.Config
    db         database.Database
    configRepo  *repository.ConfigRepository   //  новое поле
    strategies map[string]models.Strategy
    bots       map[int]*BotInstance // configID -> BotInstance
    mu         sync.RWMutex
}

// NewBotManager создает новый менеджер ботов
func NewBotManager(cfg *config.Config, db Database) *BotManager {
    return &BotManager{
        cfg:        cfg,
        db:         db,
        configRepo: repository.NewConfigRepository(db),  //  создаём здесь
        strategies: make(map[string]models.Strategy),
        bots:       make(map[int]*BotInstance),
    }
}

// StartBot запускает бота по его конфигурации из БД
func (m *BotManager) StartBot(botUserID, configID int) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    if _, exists := m.bots[configID]; exists {
        return fmt.Errorf("bot with config ID %d is already running", configID)
    }

    ctx := context.Background()

    cfg, err := m.configRepo.LoadBotConfig(ctx, configID)
    if err != nil {
        return fmt.Errorf("failed to load config for bot %d: %v", configID, err)
    }

    // Создаём общие зависимости (один раз на бота)
    marketProv := data.NewProvider(m.db)
//  OrderRepository реализует интерфейс OrderManager (является менеджером ордеров)
    historyRepo := repository.NewStrategyHistoryRepository(m.db)
    sessionID := uuid.New().String()
    orderMgr := order.NewOrderRepository(m.db)
    orderMgr.SetHistoryRecorder(&orderHistoryRecorder{
        repo:      historyRepo,
        configID:  configID,
        botUserID: botUserID,
        version:   cfg.Strategy.Version,
        sessionID: sessionID,
    })
    factory := strategies.NewFactory()
    var strategy models.Strategy

    switch cfg.Strategy.CodeName {
    case "conservative_market_maker":
        strategy = factory.NewConservativeMarketMaker(marketProv, orderMgr) 
        if strategy == nil {
            return fmt.Errorf("factory returned nil strategy for conservative_market_maker")
        }
        log.Printf("Strategy created: %T", strategy)

    case "market_maker_classic":
        // strategy = factory.NewMarketMakerClassic(marketProv, orderMgr)
        // пока закомментировано  раскомментируй, когда реализуешь

    case "grid_trading":
         strategy = factory.NewGridTrading(marketProv, orderMgr)

    case "counter_liquidity":
        strategy = factory.NewCounterLiquidity(marketProv, orderMgr)
        if strategy == nil {
            return fmt.Errorf("factory returned nil strategy for counter_liquidity")
        }
        log.Printf("Strategy created: %T", strategy)

    case "scalper":
        strategy = factory.NewScalper(marketProv, orderMgr)
        if strategy == nil {
            return fmt.Errorf("factory returned nil strategy for scalper")
        }
        log.Printf("Strategy created: %T", strategy)

    case "trend_following":
        // strategy = factory.NewTrendFollowing(marketProv, orderMgr)

    case "arbitrage":
        // strategy = factory.NewArbitrage(marketProv, orderMgr)

    default:
        return fmt.Errorf("unknown strategy code: %q", cfg.Strategy.CodeName)
    }

    if strategy == nil {
        return fmt.Errorf("strategy %q not implemented yet", cfg.Strategy.CodeName)
    }

    botInstance, err := NewBotInstance(
        configID,
        botUserID,
        cfg,
        strategy,
        m.db,
        historyRepo,
        sessionID,
    )
    if err != nil {
        return fmt.Errorf("failed to create bot instance: %v", err)
    }

    if err := botInstance.Start(); err != nil {
        return fmt.Errorf("failed to start bot: %v", err)
    }

    m.bots[configID] = botInstance

    log.Printf(" Bot started: ID=%d, Name='%s', Strategy='%s'",
        configID, cfg.Name, cfg.Strategy.CodeName)

    return nil
}
// loadBotConfig загружает конфигурацию бота из БД
func (m *BotManager) loadBotConfig(configID int) (*models.BotConfig, error) {
    ctx := context.Background()

    query := `
        SELECT id, name, bot_user_id, strategy, parameters
        FROM bot_configs
        WHERE id = $1
    `
    var (
        id           int
        name         string
        botUserID    int
        strategyJSON []byte
        paramsJSON   []byte
    )

    row := m.db.QueryRow(ctx, query, configID)
    err := row.Scan(&id, &name, &botUserID, &strategyJSON, &paramsJSON)
    if err != nil {
        return nil, err
    }

    // Парсим JSON
    var strategy models.StrategyConfig
    if err := json.Unmarshal(strategyJSON, &strategy); err != nil {
        return nil, fmt.Errorf("failed to parse strategy JSON: %v", err)
    }

    var parameters map[string]interface{}
    if err := json.Unmarshal(paramsJSON, &parameters); err != nil {
        return nil, fmt.Errorf("failed to parse parameters JSON: %v", err)
    }

    return &models.BotConfig{
        ID:         id,
        Name:       name,
        BotUserID:  botUserID,
        Strategy:   strategy,
        Parameters: parameters,
    }, nil
}

// GetActiveBots возвращает список активных ботов
func (m *BotManager) GetActiveBots() []*BotInstance {
    m.mu.RLock()
    defer m.mu.RUnlock()

    activeBots := make([]*BotInstance, 0, len(m.bots))
    for _, bot := range m.bots {
        if bot != nil && bot.IsActive() {
            activeBots = append(activeBots, bot)
        }
    }
    return activeBots
}

// StopBot останавливает бота
func (m *BotManager) StopBot(configID int) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    bot, exists := m.bots[configID]
    if !exists {
        return fmt.Errorf("bot with config ID %d not found", configID)
    }

    if err := bot.Stop(); err != nil {
        return err
    }

    delete(m.bots, configID)
    log.Printf("🛑 Bot stopped: ID=%d", configID)
    return nil
}
