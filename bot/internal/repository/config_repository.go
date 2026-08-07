// internal/repository/config_repository.go
package repository

import (
    "context"
    "encoding/json"
    "fmt"

//    "github.com/ixbaseANT/bot/internal/bot"       // или models, если BotConfig там
    "github.com/ixbaseANT/bot/internal/database"
    "github.com/ixbaseANT/bot/internal/models"   //  здесь
)

type ConfigRepository struct {
    db database.Database
}

func NewConfigRepository(db database.Database) *ConfigRepository {
    return &ConfigRepository{db: db}
}

func (r *ConfigRepository) LoadBotConfig(ctx context.Context, configID int) (*models.BotConfig, error) {
    query := `
        SELECT id, name, bot_user_id, strategy, parameters
        FROM bot_configs
        WHERE id = $1
    `
    var (
        id         int
        name       string
        botUserID  int
        strategyJSON []byte
        paramsJSON   []byte
    )
    row := r.db.QueryRow(ctx, query, configID)
    err := row.Scan(&id, &name, &botUserID, &strategyJSON, &paramsJSON)
    if err != nil {
        return nil, fmt.Errorf("query config %d: %w", configID, err)
    }
    var strategy models.StrategyConfig
    if err := json.Unmarshal(strategyJSON, &strategy); err != nil {
        return nil, err
    }
    var parameters map[string]any
    if err := json.Unmarshal(paramsJSON, &parameters); err != nil {
        return nil, err
    }
    return &models.BotConfig{
        ID:         id,
        Name:       name,
        BotUserID:  botUserID,
        Strategy:   strategy,
        Parameters: parameters,
    }, nil
}
