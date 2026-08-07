package repository

import (
    "context"
    "encoding/json"
    "fmt"
    "log"

    "github.com/ixbaseANT/bot/internal/database"
    "github.com/ixbaseANT/bot/internal/models"
)
type BotRepository struct {
    db database.Database 
}

func NewBotRepository(db database.Database) *BotRepository {
    return &BotRepository{db: db}
}

// GetBotPairs - получает торговые пары бота
func (d *BotRepository) GetBotPairs(ctx2 context.Context, botID int) ([]models.BotPair, error) {
    ctx := context.Background()  
    query := `
        SELECT id, bot_id, symbol, base_asset, quote_asset, min_price, max_price,
               grid_levels, grid_spacing, max_position_size, min_order_size,
               max_order_size, is_active, settings, created_at, updated_at
        FROM bot_pairs
        WHERE bot_id = $1 AND is_active = true
        ORDER BY symbol
    `
    rows, err := d.db.Query(ctx, query, botID)
    if err != nil {
        return nil, fmt.Errorf("failed to get bot pairs: %w", err)
    }
    defer rows.Close()
    var pairs []models.BotPair
    for rows.Next() {
        var pair models.BotPair
        var settingsJSON []byte
        err := rows.Scan(
            &pair.ID, &pair.BotID, &pair.Symbol, &pair.BaseAsset, &pair.QuoteAsset,
            &pair.MinPrice, &pair.MaxPrice, &pair.GridLevels, &pair.GridSpacing,
            &pair.MaxPositionSize, &pair.MinOrderSize, &pair.MaxOrderSize,
            &pair.IsActive, &settingsJSON, &pair.CreatedAt, &pair.UpdatedAt,
        )
        if err != nil {
            return nil, fmt.Errorf("failed to scan bot pair: %w", err)
        }
        // Декодируем JSON настройки
        if len(settingsJSON) > 0 {
            var settings models.JSONB
            if err := json.Unmarshal(settingsJSON, &settings); err == nil {
                pair.Settings = settings
            } else {
                log.Printf("Error unmarshaling settings: %v", err)
                pair.Settings = make(models.JSONB)
            }
        } else {
            pair.Settings = make(models.JSONB)
        }
        pairs = append(pairs, pair)
    }
    if err := rows.Err(); err != nil { return nil, fmt.Errorf("error iterating rows: %w", err) }
    return pairs, nil
}

// Пример: реализация метода LoadBotPairs (переписанный под pgx)
func (d *BotRepository) LoadBotPairs() ([]models.BotPair, error) {
    ctx := context.Background()
    rows, err := d.db.Query(ctx, `
        SELECT id, bot_id, symbol, base_asset, quote_asset,
               min_price, max_price, grid_levels, grid_spacing,
               max_position_size, min_order_size, max_order_size,
               is_active, settings, created_at, updated_at
        FROM bot_pairs
        WHERE is_active = true
        ORDER BY symbol
    `)
    if err != nil {
        return nil, fmt.Errorf("query bot_pairs: %w", err)
    }
    defer rows.Close()

    var pairs []models.BotPair
    for rows.Next() {
        var p models.BotPair
        var settingsJSON json.RawMessage
        err := rows.Scan(
            &p.ID, &p.BotID, &p.Symbol, &p.BaseAsset, &p.QuoteAsset,
            &p.MinPrice, &p.MaxPrice, &p.GridLevels, &p.GridSpacing,
            &p.MaxPositionSize, &p.MinOrderSize, &p.MaxOrderSize,
            &p.IsActive, &settingsJSON, &p.CreatedAt, &p.UpdatedAt,
        )
        if err != nil {
            log.Printf("scan bot pair error: %v", err)
            continue
        }

        if len(settingsJSON) > 0 {
            var settings models.JSONB
            if json.Unmarshal(settingsJSON, &settings) == nil {
                p.Settings = settings
            } else {
                p.Settings = make(models.JSONB)
            }
        } else {
            p.Settings = make(models.JSONB)
        }

        pairs = append(pairs, p)
    }

    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("rows error: %w", err)
    }

    return pairs, nil
}
