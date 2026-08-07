package order

import (
    "context"

    "github.com/ixbaseANT/bot/internal/models"
)

// HistoryRecorder записывает события журнала стратегий из точки исполнения ордеров
type HistoryRecorder interface {
    RecordEvent(ctx context.Context, event models.StrategyHistory) error
}

// SetHistoryRecorder подключает recorder к репозиторию ордеров
func (r *OrderRepository) SetHistoryRecorder(rec HistoryRecorder) {
    r.recorder = rec
}
