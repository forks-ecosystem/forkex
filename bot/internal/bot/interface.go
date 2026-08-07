package bot

import (
    "time"
//    "fmt"

//    "github.com/ixbaseANT/bot/internal/models"
//    "github.com/ixbaseANT/bot/internal/repository"
)
/*
type MarketData struct {
    Symbol      string
    Price       float64
    Bid         float64
    Ask         float64
    Volume24h   float64
    Change24h   float64
    Timestamp   time.Time
}
*/
// MarketData рыночные данные
type MarketData struct {
    Symbol       string
    Price        float64
    Bid          float64
    Ask          float64
    CurrentPrice float64
    BidPrice     float64
    AskPrice     float64
    Spread       float64
//    OrderBook    OrderBookData
//    Candles      []CandleData
    Volume24h    float64
    Volatility   float64
    Timestamp    time.Time
}

