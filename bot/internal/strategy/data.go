// internal/strategy/data.go
package strategy

import (
    "time"
)

// StrategyData - общие данные для всех стратегий
type StrategyData struct {
    MidPrice      float64                 `json:"mid_price"`
    Prices        map[string]float64      `json:"prices"`         // для арбитража
    Indicators    map[string]float64      `json:"indicators"`     // для следования тренду
    OrderBook     OrderBookData           `json:"order_book"`     // данные стакана
    MarketMetrics map[string]MarketMetric `json:"market_metrics"` // метрики рынка
    Timestamp     time.Time               `json:"timestamp"`
}

// OrderBookData - данные стакана заявок
type OrderBookData struct {
    Bids []OrderBookEntry `json:"bids"`
    Asks []OrderBookEntry `json:"asks"`
}

// OrderBookEntry - элемент стакана
type OrderBookEntry struct {
    Price  float64 `json:"price"`
    Amount float64 `json:"amount"`
}

// MarketMetric - метрика рынка
type MarketMetric struct {
    Volume24h    float64 `json:"volume_24h"`
    Spread       float64 `json:"spread"`
    Volatility   float64 `json:"volatility"`
    Liquidity    float64 `json:"liquidity"`
}