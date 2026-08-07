// internal/repository/strategy_history_repository.go
package repository

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/ixbaseANT/bot/internal/database"
    "github.com/ixbaseANT/bot/internal/models"
)

type StrategyHistoryRepository struct {
    db database.Database
}

func NewStrategyHistoryRepository(db database.Database) *StrategyHistoryRepository {
    return &StrategyHistoryRepository{db: db}
}

// RecordEvent записывает событие в журнал истории стратегий
func (r *StrategyHistoryRepository) RecordEvent(ctx context.Context, e models.StrategyHistory) error {
    if e.Timestamp.IsZero() {
        e.Timestamp = time.Now()
    }

    var contextJSON []byte
    if e.Context != nil {
        b, err := json.Marshal(e.Context)
        if err != nil {
            return fmt.Errorf("marshal context: %w", err)
        }
        contextJSON = b
    }
    contextValue := string(contextJSON)
    if contextValue == "" {
        contextValue = "{}"
    }

    query := `
        INSERT INTO strategy_history (
            strategy_id, bot_user_id, version, session_id, timestamp, event, state,
            symbol, timeframe, price, volume, signal, action,
            order_id, position_id, result, pnl,
            context, comment, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                  $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    `
    _, err := r.db.Exec(ctx, query,
        e.StrategyID, e.BotUserID, e.Version, e.SessionID, e.Timestamp, string(e.Event),
        e.State, e.Symbol, e.Timeframe, e.Price, e.Volume, e.Signal, e.Action,
        e.OrderID, e.PositionID, e.Result, e.PnL,
        contextValue, e.Comment, e.CreatedBy,
    )
    if err != nil {
        return fmt.Errorf("record strategy history event %q: %w", e.Event, err)
    }
    return nil
}

// GetHistory возвращает историю событий для конфигурации стратегии
func (r *StrategyHistoryRepository) GetHistory(ctx context.Context, strategyID int, limit int) ([]models.StrategyHistory, error) {
    if limit <= 0 || limit > 1000 {
        limit = 100
    }

    query := `
        SELECT id, strategy_id, bot_user_id, version, session_id, timestamp, event, state,
               symbol, timeframe, price, volume, signal, action,
               order_id, position_id, result, pnl, context, comment, created_by, created_at
        FROM strategy_history
        WHERE strategy_id = $1
        ORDER BY timestamp DESC
        LIMIT $2
    `

    rows, err := r.db.Query(ctx, query, strategyID, limit)
    if err != nil {
        return nil, fmt.Errorf("query strategy history: %w", err)
    }
    defer rows.Close()

    var events []models.StrategyHistory
    for rows.Next() {
        var e models.StrategyHistory
        var contextJSON []byte
        if err := rows.Scan(
            &e.ID, &e.StrategyID, &e.BotUserID, &e.Version, &e.SessionID, &e.Timestamp,
            &e.Event, &e.State, &e.Symbol, &e.Timeframe, &e.Price, &e.Volume,
            &e.Signal, &e.Action, &e.OrderID, &e.PositionID, &e.Result, &e.PnL,
            &contextJSON, &e.Comment, &e.CreatedBy, &e.CreatedAt,
        ); err != nil {
            return nil, fmt.Errorf("scan strategy history event: %w", err)
        }
        if len(contextJSON) > 0 {
            var ctxMap map[string]any
            if err := json.Unmarshal(contextJSON, &ctxMap); err == nil {
                e.Context = ctxMap
            }
        }
        events = append(events, e)
    }
    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("iterate strategy history rows: %w", err)
    }

    return events, nil
}

// GetByEvent возвращает события определенного типа для конфигурации стратегии
func (r *StrategyHistoryRepository) GetByEvent(ctx context.Context, strategyID int, event models.StrategyEvent, limit int) ([]models.StrategyHistory, error) {
    if limit <= 0 || limit > 1000 {
        limit = 100
    }

    query := `
        SELECT id, strategy_id, bot_user_id, version, session_id, timestamp, event, state,
               symbol, timeframe, price, volume, signal, action,
               order_id, position_id, result, pnl, context, comment, created_by, created_at
        FROM strategy_history
        WHERE strategy_id = $1 AND event = $2
        ORDER BY timestamp DESC
        LIMIT $3
    `

    rows, err := r.db.Query(ctx, query, strategyID, string(event), limit)
    if err != nil {
        return nil, fmt.Errorf("query strategy history by event: %w", err)
    }
    defer rows.Close()

    var events []models.StrategyHistory
    for rows.Next() {
        var e models.StrategyHistory
        var contextJSON []byte
        if err := rows.Scan(
            &e.ID, &e.StrategyID, &e.BotUserID, &e.Version, &e.SessionID, &e.Timestamp,
            &e.Event, &e.State, &e.Symbol, &e.Timeframe, &e.Price, &e.Volume,
            &e.Signal, &e.Action, &e.OrderID, &e.PositionID, &e.Result, &e.PnL,
            &contextJSON, &e.Comment, &e.CreatedBy, &e.CreatedAt,
        ); err != nil {
            return nil, fmt.Errorf("scan strategy history event: %w", err)
        }
        if len(contextJSON) > 0 {
            var ctxMap map[string]any
            if err := json.Unmarshal(contextJSON, &ctxMap); err == nil {
                e.Context = ctxMap
            }
        }
        events = append(events, e)
    }
    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("iterate strategy history rows: %w", err)
    }

    return events, nil
}
