// internal/market/data/interfaces.go
package data

import (
    "github.com/ixbaseANT/bot/internal/market"
)

type MarketDataProvider interface {
    GetMarketPrice(symbol string) (float64, error)
    GetCandles(symbol string, timeframe string, limit int) ([]market.Candle, error)
    GetOrderBook(symbol string, depth int) (market.OrderBook, error)
}
