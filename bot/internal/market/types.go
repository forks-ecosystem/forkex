package market

import (
    "time"
)

// MarketData основные рыночные данные
type MarketData struct {
    PairID       int
    Symbol       string
    Timestamp    time.Time
    CurrentPrice float64
    BidPrice     float64
    AskPrice     float64
    Spread       float64
    Volume24h    float64
    Change24h    float64
}

// Candle свеча
type Candle struct {
    Timestamp time.Time
    Open      float64
    High      float64
    Low       float64
    Close     float64
    Volume    float64
}

type OrderBook struct {
    PairID    int
    Symbol    string
    Timestamp time.Time
    Bids []PriceLevel `json:"bids"`
    Asks []PriceLevel `json:"asks"`
}


type PriceLevel struct {
    Price  float64 `json:"price"`
    Quantity float64 `json:"amount"`
}

// MarketSnapshot снимок рынка
type MarketSnapshot struct {
    PairID    int
    Timestamp time.Time
    MarketData
    LastCandle  *Candle
    OrderBook   *OrderBook
    Indicators  map[string]float64
}

