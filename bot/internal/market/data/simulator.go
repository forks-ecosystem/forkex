package data
import (
    "math/rand"
    "time"

    "github.com/ixbaseANT/bot/internal/market"
)
// internal/market/data/simulator.go
func GenerateCandle(prev *market.Candle, currentPrice float64) market.Candle {
    open := prev.Close
    close := currentPrice + (rand.Float64()-0.5)*currentPrice*0.01  // 1% volatility
    high := max(open, close) + rand.Float64()*currentPrice*0.005
    low := min(open, close) - rand.Float64()*currentPrice*0.005
    volume := rand.Float64() * 1000 + 500
    return market.Candle{Timestamp: time.Now(), Open: open, High: high, Low: low, Close: close, Volume: volume}
}

func SimulateOrderBook(price float64, depth int) market.OrderBook {
    bids := make([]market.PriceLevel, depth)
    asks := make([]market.PriceLevel, depth)
    for i := 0; i < depth; i++ {
        bidPrice := price - float64(i+1)*price*0.001
        askPrice := price + float64(i+1)*price*0.001
        amount := rand.Float64()*10 + 1
        bids[i] = market.PriceLevel{Price: bidPrice, Quantity: amount}
        asks[i] = market.PriceLevel{Price: askPrice, Quantity: amount}
    }
    return market.OrderBook{Bids: bids, Asks: asks}
}


