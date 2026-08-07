package main

import (
    "database/sql"
    "encoding/json"
    "fmt"
    "log"
    "math"
    "math/rand"
    "net/http"
    "os"
    "strconv"
    "strings"
    "time"
    "context"
    "sync"

    "github.com/joho/godotenv"
    _ "github.com/lib/pq"
)

// ------------------ КОНФИГУРАЦИЯ ------------------

type Config struct {
    BinancePollInterval time.Duration
    ForkPollInterval    time.Duration
    ReloadInterval      time.Duration
    DBDSN               string
}

var (
    loops   = make(map[string]context.CancelFunc)
    loopsMu sync.Mutex
)

var config Config
var db *sql.DB

func LoadConfig() error {
    err := godotenv.Load("/opt/forkex/.env")
    if err != nil {
        log.Printf("Warning: .env file not found, using environment variables: %v", err)
    }

    binanceInterval := getEnv("BINANCE_POLL_INTERVAL", "3s")
    forkInterval := getEnv("FORK_POLL_INTERVAL", "7s")
    reloadInterval := getEnv("RELOAD_INTERVAL", "5m")

    binanceDur, err := time.ParseDuration(binanceInterval)
    if err != nil {
        return fmt.Errorf("invalid BINANCE_POLL_INTERVAL: %v", err)
    }

    forkDur, err := time.ParseDuration(forkInterval)
    if err != nil {
        return fmt.Errorf("invalid FORK_POLL_INTERVAL: %v", err)
    }

    reloadDur, err := time.ParseDuration(reloadInterval)
    if err != nil {
        reloadDur = 5 * time.Minute
    }

    config = Config{
        BinancePollInterval: binanceDur,
        ForkPollInterval:    forkDur,
        ReloadInterval:      reloadDur,
        DBDSN:               getEnv("DB_DSN", ""),
    }

    if config.DBDSN == "" {
        return fmt.Errorf("DB_DSN environment variable is required")
    }

    log.Printf("Configuration loaded:")
    log.Printf("  Binance poll interval: %v", config.BinancePollInterval)
    log.Printf("  Fork poll interval: %v", config.ForkPollInterval)
    log.Printf("  Reload interval: %v", config.ReloadInterval)
    log.Printf("  DB DSN: %s", maskPassword(config.DBDSN))

    return nil
}

func getEnv(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}

func maskPassword(dsn string) string {
    parts := strings.Split(dsn, " ")
    for i, part := range parts {
        if strings.HasPrefix(part, "password=") {
            parts[i] = "password=***"
        }
    }
    return strings.Join(parts, " ")
}

// ------------------ ТИПЫ ------------------

type Pair struct {
    Symbol           string
    PriceSource      string
    PriceAnchor      sql.NullString
    PriceTarget      float64
    PriceVolatility  float64
    UpdateSeconds    int
    PriceFreeze      bool
    Active           bool
    PriceMin         float64
    PriceMax         float64
}

// ------------------ DB ФУНКЦИИ ------------------

func SetMarketPrice(symbol string, price float64, source string) error {
    _, err := db.Exec(`
        INSERT INTO market_prices(symbol, price, source, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (symbol)
        DO UPDATE SET price = $2, source = $3, updated_at = NOW()
    `, symbol, price, source)

    if err != nil {
        log.Printf("DB error updating market_prices for %s: %v", symbol, err)
        return err
    }

    _, err = db.Exec(`
        UPDATE pairs
        SET estimated_price = $1,
            last_price_at = NOW(),
            updated_at = NOW()
        WHERE symbol = $2
    `, price, symbol)

    if err != nil {
        log.Printf("DB error updating pairs for %s: %v", symbol, err)
        return err
    }

    return nil
}

func GetMarketPrice(symbol string) float64 {
    var price float64
    err := db.QueryRow(
        `SELECT price FROM market_prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1`,
        symbol,
    ).Scan(&price)

    if err != nil {
        err = db.QueryRow(
            `SELECT estimated_price FROM pairs WHERE symbol = $1`,
            symbol,
        ).Scan(&price)
        if err != nil {
            return 0
        }
    }
    return price
}

func LoadPairs() ([]Pair, error) {
    rows, err := db.Query(`
        SELECT
            symbol,
            price_source,
            price_anchor,
            price_target,
            price_volatility,
            EXTRACT(EPOCH FROM price_update_interval::interval)::int as update_seconds,
            price_freeze,
            active,
            price_min,
            price_max
        FROM pairs
        WHERE active = true
        AND price_source IN ('binance', 'derived', 'kucoin', 'static')
        ORDER BY symbol
    `)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var pairs []Pair
    for rows.Next() {
        var p Pair
        var updateSeconds sql.NullInt64

        err := rows.Scan(
            &p.Symbol,
            &p.PriceSource,
            &p.PriceAnchor,
            &p.PriceTarget,
            &p.PriceVolatility,
            &updateSeconds,
            &p.PriceFreeze,
            &p.Active,
            &p.PriceMin,
            &p.PriceMax,
        )
        if err != nil {
            log.Printf("scan error: %v", err)
            continue
        }

        if updateSeconds.Valid {
            p.UpdateSeconds = int(updateSeconds.Int64)
        } else {
            p.UpdateSeconds = 7
        }

        pairs = append(pairs, p)
    }

    return pairs, nil
}

// ------------------ БИРЖЕВЫЕ API ------------------

func GetBinancePrice(symbol string) (float64, error) {
    pair := strings.ToUpper(strings.ReplaceAll(symbol, "-", ""))
    url := fmt.Sprintf(
        "https://api.binance.com/api/v3/ticker/price?symbol=%s",
        pair,
    )

    resp, err := http.Get(url)
    if err != nil {
        return 0, err
    }
    defer resp.Body.Close()

    var data struct {
        Price string `json:"price"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
        return 0, err
    }
    return strconv.ParseFloat(data.Price, 64)
}
/*
https://api.hollaex.com/v2/oracle/prices?&assets=xht&quote=usdt&amount=1
*/
func GetKuCoinPrice(symbol string) (float64, error) {
    pair := strings.ToUpper(strings.ReplaceAll(symbol, "-", "-"))
    url := fmt.Sprintf(
        "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=%s",
        pair,
    )

    resp, err := http.Get(url)
    if err != nil {
        return 0, err
    }
    defer resp.Body.Close()

    var data struct {
        Data struct {
            Price string `json:"price"`
        } `json:"data"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
        return 0, err
    }
    return strconv.ParseFloat(data.Data.Price, 64)
}

// ------------------ ОРАКУЛЬНЫЕ ЦИКЛЫ ------------------

func AnchorLoop(ctx context.Context, p Pair) {
    interval := time.Duration(p.UpdateSeconds) * time.Second
    if interval == 0 {
        interval = config.BinancePollInterval
    }

    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            log.Printf("[anchor] stopped %s", p.Symbol)
            return
        case <-ticker.C:
            if p.PriceFreeze {
                continue
            }

            var price float64
            var err error
            var source string

            switch p.PriceSource {
            case "binance":
                price, err = GetBinancePrice(p.Symbol)
                source = "binance"
            case "kucoin":
                price, err = GetKuCoinPrice(p.Symbol)
                source = "kucoin"
            default:
                continue
            }

            if err == nil && price > 0 {
                SetMarketPrice(p.Symbol, price, source)
                log.Printf("[anchor] %s = %.8f (%s)", p.Symbol, price, source)
            }
        }
    }
}

func ForkLoop(ctx context.Context, p Pair) {
    if !p.PriceAnchor.Valid {
        return
    }

    interval := time.Duration(p.UpdateSeconds) * time.Second
    if interval == 0 {
        interval = config.ForkPollInterval
    }

    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            log.Printf("[fork] stopped %s", p.Symbol)
            return
        case <-ticker.C:
            if p.PriceFreeze {                continue            }
            anchor := GetMarketPrice(p.PriceAnchor.String)
            if anchor == 0 {                continue            }
            price := anchor * p.PriceTarget
            // Add volatility if configured
            if p.PriceVolatility > 0 {
                noise := (rand.Float64()*2 - 1) * p.PriceVolatility
                price = price * (1 + noise)
            }
            // Apply price limits
            if p.PriceMin > 0 && price < p.PriceMin {
                price = p.PriceMin
            }
            if p.PriceMax > 0 && price > p.PriceMax {
                price = p.PriceMax
            }
            SetMarketPrice(p.Symbol, price, "derived")
            log.Printf("[fork] %s = %.8f (anchor: %s = %.8f)", 
                p.Symbol, price, p.PriceAnchor.String, anchor)
        }
    }
}

func StaticLoop(ctx context.Context, p Pair) {
    interval := 30 * time.Second
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            log.Printf("[static] stopped %s", p.Symbol)
            return
        case <-ticker.C:
            if p.PriceFreeze {
                continue
            }

            currentPrice := GetMarketPrice(p.Symbol)
            targetPrice := p.PriceTarget

            if math.Abs(currentPrice-targetPrice) > 0.00000001 {
                SetMarketPrice(p.Symbol, targetPrice, "static")
                log.Printf("[static] %s = %.8f", p.Symbol, targetPrice)
            }
        }
    }
}

// ------------------ ПЕРЕЗАГРУЗКА КОНФИГА ------------------

func ReloadPairs() {
    log.Println("Reloading pairs configuration...")

    pairs, err := LoadPairs()
    if err != nil {
        log.Printf("Error loading pairs: %v", err)
        return
    }

    loopsMu.Lock()
    for _, cancel := range loops {
        cancel()
    }
    loops = make(map[string]context.CancelFunc)
    loopsMu.Unlock()

    log.Printf("Loaded %d active pairs", len(pairs))

    for _, p := range pairs {
        if !p.Active {
            continue
        }

        ctx, cancel := context.WithCancel(context.Background())

        loopsMu.Lock()
        loops[p.Symbol] = cancel
        loopsMu.Unlock()

        switch p.PriceSource {
        case "binance", "kucoin":
            go AnchorLoop(ctx, p)
            log.Printf("Started anchor loop for %s", p.Symbol)
        case "derived":
            go ForkLoop(ctx, p)
            log.Printf("Started fork loop for %s (anchor: %v)", p.Symbol, p.PriceAnchor.String)
        case "static":
            go StaticLoop(ctx, p)
            log.Printf("Started static loop for %s", p.Symbol)
        }
    }
}

// ------------------ MAIN ------------------

func main() {
    rand.Seed(time.Now().UnixNano())
    log.Println("🚀 Starting Price Oracle...")

    if err := LoadConfig(); err != nil {
        log.Fatal("Configuration error:", err)
    }

    var err error
    db, err = sql.Open("postgres", config.DBDSN)
    if err != nil {
        log.Fatal("Database connection error:", err)
    }
    defer db.Close()

    if err := db.Ping(); err != nil {
        log.Fatal("Database ping error:", err)
    }

    log.Println("✅ Database connected successfully")

    ReloadPairs()

    reloadTicker := time.NewTicker(config.ReloadInterval)
    defer reloadTicker.Stop()

    log.Println("✅ Price Oracle started successfully")
    log.Println("   Press Ctrl+C to stop")

    for {
        select {
        case <-reloadTicker.C:
            ReloadPairs()
        }
    }
}
