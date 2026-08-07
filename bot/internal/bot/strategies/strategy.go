package strategies

import "github.com/ixbaseANT/bot/internal/models"

type Strategy interface {
    Execute(ctx *models.BotContext) error
    GetName() string
    GetCodeName() string
    CalculateMetrics(ctx *models.BotContext) map[string]interface{}
}
