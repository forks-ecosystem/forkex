package market

import (
    "time"

    "github.com/ixbaseANT/bot/internal/database"
//    "github.com/ixbaseANT/bot/internal/bot/market"
)

// concrete implementation
type Provider struct {
    db database.Database
}

// OrderBookLevel уровень стакана
type OrderBookLevel struct {
    Price     float64
    Quantity  float64
    OrderCount int
}
// OrderBook структура стакана
type OrderBook struct {
    Symbol    string
    Bids      []OrderBookLevel // Покупатели
    Asks      []OrderBookLevel // Продавцы
    Timestamp time.Time
}
// Candle структура свечи
type Candle struct {
    Open      float64
    High      float64
    Low       float64
    Close     float64
    Volume    float64
    Timestamp time.Time
    IsClosed  bool
}
// TickerData структура тикера
type TickerData struct {
    Symbol    string
    LastPrice float64
    BidPrice  float64
    AskPrice  float64
    Volume24h float64
    High24h   float64
    Low24h    float64
    Timestamp time.Time
}
// MarketSnapshot полный снимок рынка
type MarketSnapshot struct {
    Symbol      string
    OrderBook   *OrderBook
    Ticker      *TickerData
    Candles     map[string][]Candle // interval -> candles
    Timestamp   time.Time
}
// Provider интерфейс провайдера рыночных данных
type MarketProvider interface {
    GetMarketSnapshot(pairID int, intervals []string) (*MarketSnapshot, error)
    GetOrderBook(pairID int) (*OrderBook, error)
    GetCandles(pairID int, interval string, limit int) ([]Candle, error)
    GetTicker(pairID int) (*TickerData, error)
    SubscribeToOrderBook(pairID int) (chan OrderBook, error)
}

// ⬅️ ВАЖНО: возвращаем ИНТЕРФЕЙС
//func NewProvider(db database.Database) *Provider {
//    return &Provider{db: db}
//}
func NewProvider(db database.Database) Provider {   //  без *
    return Provider{db: db}   // без &
}
/*
func (p *Provider) GetMarketData(
    symbol string,
    useCandles bool,
    useOrderbook bool,
) (*strategies.MarketData, error) {

    price, err := p.db.GetMarketPrice(symbol)
    if err != nil {
        return nil, err
    }

    // пока упрощённо — bid/ask синтетические
    bid := price * 0.999
    ask := price * 1.001

    return &strategies.MarketData{
        Symbol:       symbol,
        CurrentPrice: price,
        BidPrice:     bid,
        AskPrice:     ask,
        Spread:       (ask - bid) / price * 100,
        Volume24h:    0,          // позже
        Volatility:   0,          // позже
        Timestamp:    time.Now(),
    }, nil
}
*/