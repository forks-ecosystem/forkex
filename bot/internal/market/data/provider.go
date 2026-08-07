package data

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "math"
    "math/rand"
    "strings"
    "sync"
    "time"

    "github.com/ixbaseANT/bot/internal/database"
    "github.com/ixbaseANT/bot/internal/market"
)

// Provider предоставляет рыночные данные
type Provider struct {
	db database.Database
	isSimulated bool
}

var pairIDCache sync.Map

func (p *Provider) symbolToPairID(symbol string) int {
	normalized := strings.ToLower(strings.ReplaceAll(symbol, "-", ""))
	if id, ok := pairIDCache.Load(normalized); ok {
		return id.(int)
	}
	var id int
	err := p.db.QueryRow(context.Background(),
		`SELECT id FROM pairs WHERE LOWER(REPLACE(symbol, '-', '')) = $1 LIMIT 1`,
		normalized,
	).Scan(&id)
	if err == nil {
		pairIDCache.Store(normalized, id)
		return id
	}
	log.Printf("[symbolToPairID] DB lookup failed for %q: %v — using fallback pair_id=1", symbol, err)
	pairIDCache.Store(normalized, 1)
	return 1
}

// GetMarketPrice implements MarketDataProvider interface
func (p *Provider) GetMarketPrice(symbol string) (float64, error) {
	pairID := p.symbolToPairID(symbol)
	data, err := p.GetMarketData(context.Background(), pairID)
	if err != nil {
		return 0, err
	}
	return data.CurrentPrice, nil
}

// GetCandles implements MarketDataProvider interface
func (p *Provider) GetCandles(symbol string, timeframe string, limit int) ([]market.Candle, error) {
	pairID := p.symbolToPairID(symbol)
	return p.getCandlesByPair(context.Background(), pairID, timeframe, limit)
}

// GetOrderBook implements MarketDataProvider interface
func (p *Provider) GetOrderBook(symbol string, depth int) (market.OrderBook, error) {
	pairID := p.symbolToPairID(symbol)
	book, err := p.getOrderBookByPair(context.Background(), pairID, depth)
	if err != nil {
		return market.OrderBook{}, err
	}
	return *book, nil
}
// NewProvider создает нового провайдера
func NewProvider(db database.Database) *Provider {
    return &Provider{db: db}
}

// GetMarketSnapshot получает полный снимок рынка
func (p *Provider) GetMarketSnapshot(pair_id int) (*market.MarketSnapshot, error) {
    ctx := context.Background()
    // Получаем текущую цену
    marketData, err := p.GetMarketData(ctx, pair_id)
    if err != nil {
        return nil, fmt.Errorf("failed to get market data: %v", err)
    }
    // Получаем свечи
    candles, err := p.getCandlesByPair(ctx, pair_id, "1m", 100)
    if err != nil {
        log.Printf("Warning: failed to get candles: %v", err)
    }
    // Получаем стакан
    orderBook, err := p.getOrderBookByPair(ctx, pair_id, 20)
    if err != nil {
        log.Printf("Warning: failed to get order book: %v", err)
    }
    // Рассчитываем индикаторы
    indicators := make(map[string]float64)
    if len(candles) > 0 {
        lastCandle := candles[len(candles)-1]
        indicators = p.CalculateIndicators(candles)
        snapshot := &market.MarketSnapshot{
            PairID:     pair_id,
            Timestamp:  time.Now(),
            MarketData: *marketData,
            LastCandle: &lastCandle,
            OrderBook:  orderBook,
            Indicators: indicators,
        }
        return snapshot, nil
    }
    return &market.MarketSnapshot{
        PairID:     pair_id,
        Timestamp:  time.Now(),
        MarketData: *marketData,
        Indicators: indicators,
    }, nil
}

// GetMarketData получает основные рыночные данные (приоритет — БД)
func (p *Provider) GetMarketData(ctx context.Context, pair_id int) (*market.MarketData, error) {
    var price, volume24h, change24h float64
    err := p.db.QueryRow(ctx, `
        SELECT price, volume_24h, change_24h
        FROM market_prices
        WHERE pair_id = $1
        ORDER BY updated_at DESC LIMIT 1
    `, pair_id).Scan(&price, &volume24h, &change24h)
    if err == nil {
        log.Printf("[GetMarketData] FOUND pair_id=%d price=%f", pair_id, price)
        spread := 0.001 // 0.1% — можно сделать конфигурируемым
        bidPrice := price * (1 - spread/2)
        askPrice := price * (1 + spread/2)
        return &market.MarketData{
            PairID:       pair_id,
            Timestamp:    time.Now(),
            CurrentPrice: price,
            BidPrice:     bidPrice,
            AskPrice:     askPrice,
            Spread:       spread * 100,
            Volume24h:    volume24h,
            Change24h:    change24h,
        }, nil
    }
    // Если данных нет — симуляция (и можно сразу записать в БД)
    log.Printf("[GetMarketData] No market data for %d in DB → derive from candles or simulate", pair_id)
    // Try to derive price from latest candle
    var candlePrice float64
    err = p.db.QueryRow(ctx, `
        SELECT close FROM candles WHERE pair_id = $1 ORDER BY timestamp DESC LIMIT 1
    `, pair_id).Scan(&candlePrice)
    if err == nil && candlePrice > 0 {
        log.Printf("[GetMarketData] Derived price=%.8f from latest candle for pair_id=%d", candlePrice, pair_id)
        data := p.generateSimulatedMarketData(pair_id)
        data.CurrentPrice = candlePrice
        data.BidPrice = candlePrice * 0.9995
        data.AskPrice = candlePrice * 1.0005
        var symbol string
        _ = p.db.QueryRow(ctx, `SELECT symbol FROM pairs WHERE id = $1`, pair_id).Scan(&symbol)
        if symbol == "" {
            symbol = fmt.Sprintf("pair_%d", pair_id)
        }
        log.Printf("[GetMarketData] INSERT derived price=%.8f pair=%d symbol=%s", candlePrice, pair_id, symbol)
        _, err = p.db.Exec(ctx, `
            INSERT INTO market_prices (pair_id, symbol, price, volume_24h, change_24h, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (symbol) DO NOTHING
        `, pair_id, symbol, candlePrice, data.Volume24h, data.Change24h)
        if err != nil {
            log.Printf("Failed to insert derived market data: %v", err)
        }
        // Verify what was written
        var dbPrice float64
        _ = p.db.QueryRow(ctx, `SELECT price FROM market_prices WHERE pair_id=$1`, pair_id).Scan(&dbPrice)
        log.Printf("[GetMarketData] After insert, DB price=%.8f", dbPrice)
        return data, nil
    }
    // Fallback: simulated data
    log.Printf("[GetMarketData] No candles either → full simulation for pair_id=%d", pair_id)
    data := p.generateSimulatedMarketData(pair_id)
    return data, nil
}
// getCandlesByPair получает свечи
func (p *Provider) getCandlesByPair(ctx context.Context, pairID int, timeframe string, limit int) ([]market.Candle, error) {
	log.Printf("[getCandlesByPair] pairID=%d, timeframe=%s, limit=%d", pairID, timeframe, limit)
    // Пытаемся получить из БД
    rows, err := p.db.Query(ctx, `
        SELECT timestamp, open, high, low, close, volume
        FROM candles
        WHERE pair_id = $1 AND timeframe = $2
        ORDER BY timestamp DESC
        LIMIT $3
    `, pairID, timeframe, limit)

    if err != nil {
        // Если нет в БД, генерируем тестовые свечи
        log.Printf("No candles for %d in DB, generating simulation", pairID)
        return p.generateSimulatedCandles(pairID, timeframe, limit), nil
    }
    defer rows.Close()

    var candles []market.Candle
    for rows.Next() {
        var c market.Candle
        var ts int64
        if err := rows.Scan(&ts, &c.Open, &c.High, &c.Low, &c.Close, &c.Volume); err != nil {
            log.Printf("Error scanning candle: %v", err)
            continue
        }
        c.Timestamp = time.Unix(ts, 0)
        candles = append(candles, c)
    }

    if len(candles) == 0 {
        log.Printf("[getCandlesByPair] No candles in DB  simulation")
        return p.generateSimulatedCandles(pairID, timeframe, limit), nil
    }
    // Реверсируем порядок (от старых к новым)
    for i, j := 0, len(candles)-1; i < j; i, j = i+1, j-1 {
        candles[i], candles[j] = candles[i], candles[j]
    }

    log.Printf("[GetCandles] Got %d candles", len(candles))
    return candles, nil
}

// getOrderBookByPair получает стакан
func (p *Provider) getOrderBookByPair(ctx context.Context, pair_id int, depth int) (*market.OrderBook, error) {
//    ctx := context.Background()
    // Пытаемся получить из БД
//    pairIDRaw, _ := ctx.Config.Parameters["pair_id"]
//    pair_id, _ := pairIDRaw.(int)
    var orderBookJSON []byte
    err := p.db.QueryRow(ctx, `
        SELECT bid_price, ask_price
        FROM orderbooks
        WHERE pair_id = $1
        ORDER BY timestamp DESC LIMIT 1
    `, pair_id).Scan(&orderBookJSON)

    if err != nil {
        // Если нет в БД, генерируем тестовый стакан
        log.Printf("No order book for %d in DB, generating simulation", pair_id)
        return p.generateSimulatedOrderBook(pair_id, depth), nil
    }

    var orderBook market.OrderBook
    if err := json.Unmarshal(orderBookJSON, &orderBook); err != nil {
        return nil, fmt.Errorf("failed to unmarshal order book: %v", err)
    }

    // Ограничиваем глубину
    if len(orderBook.Bids) > depth {
        orderBook.Bids = orderBook.Bids[:depth]
    }
    if len(orderBook.Asks) > depth {
        orderBook.Asks = orderBook.Asks[:depth]
    }

    orderBook.Timestamp = time.Now()
    orderBook.PairID = pair_id

    return &orderBook, nil
}

// generateSimulatedMarketData генерирует тестовые рыночные данные
func (p *Provider) generateSimulatedMarketData(pair_id int) *market.MarketData {
    rand.Seed(time.Now().UnixNano())

    // Базовые цены для популярных пар
/*
    basePrices := map[string]float64{
        "BTCUSDT": 45000.0,
        "ETHUSDT": 2500.0,
        "BNBUSDT": 300.0,
        "ADAUSDT": 0.5,
        "DOTUSDT": 7.0,
    }

    basePrice, ok := basePrices[symbol]
    if !ok {
        basePrice = 100.0
    }
*/
    basePrice := 0.0001
    // Генерируем случайное движение (+/- 2%)
    change := (rand.Float64()*2 - 1) * 0.02
    price := basePrice * (1 + change)

    spread := 0.001 // 0.1%
    bidPrice := price * (1 - spread/2)
    askPrice := price * (1 + spread/2)

    volume24h := basePrice * 1000 * (0.8 + rand.Float64()*0.4)
    change24h := (rand.Float64()*2 - 1) * 0.05 // +/- 5%

    return &market.MarketData{
        PairID:       pair_id,
        Timestamp:    time.Now(),
        CurrentPrice: price,
        BidPrice:     bidPrice,
        AskPrice:     askPrice,
        Spread:       spread * 100,
        Volume24h:    volume24h,
        Change24h:    change24h,
    }
}

// generateSimulatedCandles генерирует тестовые свечи
func (p *Provider) generateSimulatedCandles(pair_id int, timeframe string, limit int) []market.Candle {
    var candles []market.Candle
    rand.Seed(time.Now().UnixNano())
    // Определяем интервал на основе таймфрейма
    var interval time.Duration
    switch timeframe {
    case "1m":
        interval = time.Minute
    case "5m":
        interval = 5 * time.Minute
    case "15m":
        interval = 15 * time.Minute
    case "1h":
        interval = time.Hour
    case "4h":
        interval = 4 * time.Hour
    case "1d":
        interval = 24 * time.Hour
    default:
        interval = time.Minute
    }
    // Начальная цена
    basePrice := 45000.0
    price := basePrice
    startTime := time.Now().Add(-time.Duration(limit) * interval)
    for i := 0; i < limit; i++ {
        timestamp := startTime.Add(time.Duration(i) * interval)
        // Генерируем случайное движение
        volatility := 0.002 // 0.2%
        change := (rand.Float64()*2 - 1) * volatility
        open := price
        close := price * (1 + change)
        high := math.Max(open, close) * (1 + rand.Float64()*0.001)
        low := math.Min(open, close) * (1 - rand.Float64()*0.001)
        volume := 10.0 + rand.Float64()*90.0
        candles = append(candles, market.Candle{
            Timestamp: timestamp,
            Open:      open,
            High:      high,
            Low:       low,
            Close:     close,
            Volume:    volume,
        })
        price = close
    }
    return candles
}


// generateSimulatedOrderBook генерирует тестовый стакан
func (p *Provider) generateSimulatedOrderBook(pair_id int, depth int) *market.OrderBook {
    rand.Seed(time.Now().UnixNano())
    // Текущая цена
    currentPrice := 45000.0
    var bids, asks []market.PriceLevel
    // Генерируем биды (ниже текущей цены)
    for i := 0; i < depth; i++ {
        distance := float64(i+1) * 0.001 // 0.1% шаг
        price := currentPrice * (1 - distance)
        quantity := 0.1 + rand.Float64()*0.9

        bids = append(bids, market.PriceLevel{
            Price:    price,
            Quantity: quantity,
        })
    }
    // Генерируем аски (выше текущей цены)
    for i := 0; i < depth; i++ {
        distance := float64(i+1) * 0.001 // 0.1% шаг
        price := currentPrice * (1 + distance)
        quantity := 0.1 + rand.Float64()*0.9

        asks = append(asks, market.PriceLevel{
            Price:    price,
            Quantity: quantity,
        })
    }
    return &market.OrderBook{
        PairID:    pair_id,
        Timestamp: time.Now(),
        Bids:      bids,
        Asks:      asks,
    }
}

// CalculateIndicators рассчитывает индикаторы
func (p *Provider) CalculateIndicators(candles []market.Candle) map[string]float64 {
    indicators := make(map[string]float64)
    
    if len(candles) < 20 {
        return indicators
    }
    
    // SMA (Simple Moving Average)
    indicators["sma_9"] = p.calculateSMA(candles, 9)
    indicators["sma_20"] = p.calculateSMA(candles, 20)
    indicators["sma_50"] = p.calculateSMA(candles, 50)
    
    // RSI (Relative Strength Index)
    indicators["rsi_14"] = p.calculateRSI(candles, 14)
    
    // Bollinger Bands
    bbUpper, bbMiddle, bbLower := p.calculateBollingerBands(candles, 20, 2)
    indicators["bb_upper"] = bbUpper
    indicators["bb_middle"] = bbMiddle
    indicators["bb_lower"] = bbLower
    
    // Volume
    indicators["volume_sma_20"] = p.calculateVolumeSMA(candles, 20)
    
    return indicators
}

// calculateSMA рассчитывает простое скользящее среднее
func (p *Provider) calculateSMA(candles []market.Candle, period int) float64 {
    if len(candles) < period {
        return 0
    }
    
    sum := 0.0
    for i := len(candles) - period; i < len(candles); i++ {
        sum += candles[i].Close
    }
    
    return sum / float64(period)
}

// calculateRSI рассчитывает RSI
func (p *Provider) calculateRSI(candles []market.Candle, period int) float64 {
    if len(candles) <= period {
        return 50.0
    }
    
    gains := 0.0
    losses := 0.0
    
    for i := len(candles) - period; i < len(candles); i++ {
        if i == 0 {
            continue
        }
        
        change := candles[i].Close - candles[i-1].Close
        if change > 0 {
            gains += change
        } else {
            losses -= change
        }
    }
    
    avgGain := gains / float64(period)
    avgLoss := losses / float64(period)
    
    if avgLoss == 0 {
        return 100.0
    }
    
    rs := avgGain / avgLoss
    rsi := 100 - (100 / (1 + rs))
    
    return rsi
}

// calculateBollingerBands рассчитывает полосы Боллинджера
func (p *Provider) calculateBollingerBands(candles []market.Candle, period int, stdDev float64) (float64, float64, float64) {
    sma := p.calculateSMA(candles, period)
    
    sumSquares := 0.0
    for i := len(candles) - period; i < len(candles); i++ {
        diff := candles[i].Close - sma
        sumSquares += diff * diff
    }
    
    std := math.Sqrt(sumSquares / float64(period))
    
    upper := sma + (stdDev * std)
    lower := sma - (stdDev * std)
    
    return upper, sma, lower
}

// calculateVolumeSMA рассчитывает SMA объема
func (p *Provider) calculateVolumeSMA(candles []market.Candle, period int) float64 {
    if len(candles) < period {
        return 0
    }
    
    sum := 0.0
    for i := len(candles) - period; i < len(candles); i++ {
        sum += candles[i].Volume
    }
    
    return sum / float64(period)
}
