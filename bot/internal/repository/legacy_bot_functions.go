package repository

import (
    "database/sql"
    "fmt"
    "log"
    "math/rand"
    "os"
    "sync"
    "time"
//    "context"
//    "github.com/google/uuid"

//    "github.com/joho/godotenv"
//    _ "github.com/lib/pq"
)

// ------------------ КОНФИГУРАЦИИ ------------------

type APIConfig struct {
    BaseURL   string
    APIKey    string
    APISecret string
}

type BotPair struct {
    ID           int
    PairSymbol   string
    BaseCurrency string
    QuoteCurrency string
    Spread       float64
    OrderSize    float64
    MinPrice     float64
    MaxPrice     float64
    Levels       int
    IsActive     bool
    UpdateRate   int
    MaxOrders    int
    MaxPosition  float64
    BotUserID    int
}

// ------------------ УТИЛИТЫ ------------------

func getEnv(key, defaultValue string) string {
    if value := os.Getenv(key); value != "" {
        return value
    }
    return defaultValue
}

func LoadAPIConfig() APIConfig {
    return APIConfig{
        BaseURL:   getEnv("API_BASE_URL", "http://forkex-api:10010"),
        APIKey:    getEnv("API_KEY", ""),
        APISecret: getEnv("API_SECRET", ""),
    }
}

// ------------------ DB ФУНКЦИИ ------------------

var db *sql.DB

func GetMarketPriceFromDB(symbol string) (float64, error) {
    var price float64
    err := db.QueryRow(`
        SELECT price FROM market_prices
        WHERE symbol = $1
        ORDER BY updated_at DESC LIMIT 1
    `, symbol).Scan(&price)

    if err != nil {
        log.Printf("[DB] Error getting price for %s: %v", symbol, err)
        return 0, err
    }

    return price, nil
}

func LoadBotPairs() ([]BotPair, error) {
    rows, err := db.Query(`
        SELECT
            id, pair_symbol, base_currency, quote_currency,
            spread, order_size, min_price, max_price,
            levels, is_active, update_rate, max_orders,
            max_position, bot_user_id
        FROM bot_pairs
        WHERE is_active = true
        ORDER BY pair_symbol
    `)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var pairs []BotPair
    for rows.Next() {
        var p BotPair
        err := rows.Scan(
            &p.ID,
            &p.PairSymbol,
            &p.BaseCurrency,
            &p.QuoteCurrency,
            &p.Spread,
            &p.OrderSize,
            &p.MinPrice,
            &p.MaxPrice,
            &p.Levels,
            &p.IsActive,
            &p.UpdateRate,
            &p.MaxOrders,
            &p.MaxPosition,
            &p.BotUserID,
        )
        if err != nil {
            log.Printf("Error scanning bot pair: %v", err)
            continue
        }
        pairs = append(pairs, p)
    }
    return pairs, nil
}

func UpdateBotPairLastExecuted(pairID int) {
    _, err := db.Exec(`
        UPDATE bot_pairs
        SET last_executed = NOW(), updated_at = NOW()
        WHERE id = $1
    `, pairID)

    if err != nil {
        log.Printf("Error updating last_executed for pair %d: %v", pairID, err)
    }
}

func UpdateBotPairStats(pairID int, volume float64) {
    _, err := db.Exec(`
        UPDATE bot_pairs
        SET
            total_volume = COALESCE(total_volume, 0) + $1,
            total_trades = COALESCE(total_trades, 0) + 1,
            updated_at = NOW()
        WHERE id = $2
    `, volume, pairID)

    if err != nil {
        log.Printf("Error updating stats for pair %d: %v", pairID, err)
    }
}

// Функция для записи ордера в таблицу orders
func SaveOrderToOrders(userID, pairID int, symbol, side string, price, size float64) (string, error) {
    // Генерируем UUID для order_id
    orderUUID := fmt.Sprintf("order_%d_%d", time.Now().UnixNano(), rand.Intn(1000))

    // Вставляем ордер
    _, err := db.Exec(`
        INSERT INTO orders
        (user_id, pair_id, side, price, size, status, accepted,
         symbol, order_id, fee, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'open', false,
                $6, $7, 0, NOW(), NOW())
    `, userID, pairID, side, price, size, symbol, orderUUID)

    if err != nil {
        log.Printf("[DB] Error saving order to orders table: %v", err)
        return "", err
    }

    log.Printf("[DB] Saved order %s: %s %.6f %s @ %.2f",
        orderUUID, side, size, symbol, price)
    return orderUUID, nil
}

// Обновление статуса ордера
func UpdateOrderStatus(orderUUID, status string, acceptedAmount float64) error {
    query := `
        UPDATE orders
        SET status = $1, updated_at = NOW()
        WHERE order_id = $2
    `
    args := []interface{}{status, orderUUID}

    if status == "filled" {
        query = `
            UPDATE orders
            SET status = $1, accepted = true,
                accepted_amount = $2, updated_at = NOW()
            WHERE order_id = $3
        `
        args = []interface{}{status, acceptedAmount, orderUUID}
    }

    result, err := db.Exec(query, args...)
    if err != nil {
        log.Printf("[DB] Error updating order %s: %v", orderUUID, err)
        return err
    }

    rows, _ := result.RowsAffected()
    if rows == 0 {
        return fmt.Errorf("order %s not found", orderUUID)
    }

    log.Printf("[DB] Updated order %s to %s", orderUUID, status)
    return nil
}

// Получение открытых ордеров пользователя
func GetUserOpenOrders(userID int, symbol string) ([]map[string]interface{}, error) {
    rows, err := db.Query(`
        SELECT
            id, order_id, side, price, size,
            accepted_amount, status, created_at
        FROM orders
        WHERE user_id = $1
          AND symbol = $2
          AND status = 'open'
        ORDER BY created_at DESC
        LIMIT 50
    `, userID, symbol)

    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var orders []map[string]interface{}
    for rows.Next() {
        var id int64
        var orderID, side, status string
        var price, size, acceptedAmount float64
        var createdAt time.Time

        err := rows.Scan(&id, &orderID, &side, &price, &size,
                        &acceptedAmount, &status, &createdAt)
        if err != nil {
            log.Printf("Error scanning order: %v", err)
            continue
        }

        orders = append(orders, map[string]interface{}{
            "id":              id,
            "order_id":        orderID,
            "side":            side,
            "price":           price,
            "size":            size,
            "accepted_amount": acceptedAmount,
            "status":          status,
            "created_at":      createdAt,
        })
    }

    return orders, nil
}

// ------------------ Forkex API КЛИЕНТ ------------------

type ForkexClient struct {
    config *APIConfig
}

func NewForkexClient(config *APIConfig) *ForkexClient {
    return &ForkexClient{
        config: config,
    }
}

func (c *ForkexClient) GetMarketPrice(symbol string) (float64, error) {
    return GetMarketPriceFromDB(symbol)
}

func (c *ForkexClient) PlaceOrder(symbol, side string, size, price float64) (string, error) {
    // Получаем user_id и pair_id
    var userID, pairID int
    err := db.QueryRow(`
        SELECT bot_user_id,
               (SELECT id FROM pairs WHERE name = $1 LIMIT 1) as pair_id
        FROM bot_pairs
        WHERE pair_symbol = $1 LIMIT 1
    `, symbol).Scan(&userID, &pairID)

    if err != nil {
        log.Printf("[ORDER] Error finding pair/user for %s: %v", symbol, err)
        userID = 5
        pairID = 1
    }

    return SaveOrderToOrders(userID, pairID, symbol, side, price, size)
}

func (c *ForkexClient) CancelOrder(orderUUID string) error {
    return UpdateOrderStatus(orderUUID, "canceled", 0)
}

func (c *ForkexClient) SimulateOrderFill(symbol string, currentPrice float64) {
    // Находим ордера, которые могут быть исполнены
        log.Printf("SIMULATE =========================: %v", symbol)

    rows, err := db.Query(`
        SELECT o.order_id, o.side, o.price, o.size,
               bp.bot_user_id, p.id as pair_id
        FROM orders o
        JOIN bot_pairs bp ON o.symbol = bp.pair_symbol
                         AND o.user_id = bp.bot_user_id
        JOIN pairs p ON o.symbol = p.name
        WHERE o.symbol = $1
          AND o.status = 'open'
          AND (
            (o.side = 'buy' AND o.price >= $2) OR
            (o.side = 'sell' AND o.price <= $2)
          )
        LIMIT 2
    `, symbol, currentPrice)

    if err != nil {
        log.Printf("[SIMULATE] Error getting fillable orders: %v", err)
        return
    }
    defer rows.Close()

    for rows.Next() {
        var orderUUID, side string
        var price, size float64
        var userID, pairID int

        if err := rows.Scan(&orderUUID, &side, &price, &size, &userID, &pairID); err != nil {
            continue
        }

        // Исполняем ордер
        filledSize := size
        if err := UpdateOrderStatus(orderUUID, "filled", filledSize); err == nil {
            log.Printf("[SIMULATE] Order %s filled at %.2f", orderUUID, currentPrice)
            UpdateBotPairStats(pairID, filledSize*currentPrice)
        }
    }
}

// Получение ордеров пользователя
func (c *ForkexClient) GetUserOrders(symbol string) ([]map[string]interface{}, error) {
    var userID int
    err := db.QueryRow(`
        SELECT bot_user_id FROM bot_pairs
        WHERE pair_symbol = $1 LIMIT 1
    `, symbol).Scan(&userID)

    if err != nil {
        return nil, err
    }

    return GetUserOpenOrders(userID, symbol)
}

// ------------------ МАРКЕТ-МЕЙКЕР ------------------

type MarketMaker struct {
    Pair         BotPair
    Client       *ForkexClient
    Active       bool
    mu           sync.Mutex
    stopChan     chan struct{}
    activeOrders map[string]string // orderUUID -> side
}

func NewMarketMaker(pair BotPair, apiConfig *APIConfig) *MarketMaker {
    client := NewForkexClient(apiConfig)

    return &MarketMaker{
        Pair:         pair,
        Client:       client,
        Active:       pair.IsActive,
        stopChan:     make(chan struct{}),
        activeOrders: make(map[string]string),
    }
}

func (mm *MarketMaker) Start() {
    if !mm.Active {
        log.Printf("[bot] Pair %s is inactive", mm.Pair.PairSymbol)
        return
    }

    log.Printf("[bot] Starting market maker for %s", mm.Pair.PairSymbol)
    log.Printf("      Spread: %.2f%%, Order size: %.6f, Levels: %d, Update: %ds",
        mm.Pair.Spread, mm.Pair.OrderSize, mm.Pair.Levels, mm.Pair.UpdateRate)

    go mm.run()
}

func (mm *MarketMaker) Stop() {
    close(mm.stopChan)
    mm.Active = false

    mm.cancelAllOrders()
    log.Printf("[bot] Stopped market maker for %s", mm.Pair.PairSymbol)
}

func (mm *MarketMaker) cancelAllOrders() {
    for orderUUID := range mm.activeOrders {
        if err := mm.Client.CancelOrder(orderUUID); err != nil {
            log.Printf("[bot] %s error canceling order: %v", mm.Pair.PairSymbol, err)
        }
    }
    mm.activeOrders = make(map[string]string)
}

func (mm *MarketMaker) run() {
    interval := time.Duration(mm.Pair.UpdateRate) * time.Second
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    mm.updateMarket()

    for {
        select {
        case <-ticker.C:
            mm.updateMarket()
        case <-mm.stopChan:
            return
        }
    }
}

func (mm *MarketMaker) updateMarket() {
    mm.mu.Lock()
    defer mm.mu.Unlock()

    if !mm.Active {
        return
    }

    log.Printf("[bot] %s updating market...", mm.Pair.PairSymbol)

    // 1. Получаем текущую цену
    marketPrice, err := mm.Client.GetMarketPrice(mm.Pair.PairSymbol)
    if err != nil {
        log.Printf("[bot] %s error getting price: %v", mm.Pair.PairSymbol, err)
        return
    }

    // 2. Симулируем исполнение ордеров
    mm.Client.SimulateOrderFill(mm.Pair.PairSymbol, marketPrice)

    // 3. Применяем лимиты цены
    if mm.Pair.MinPrice > 0 && marketPrice < mm.Pair.MinPrice {
        marketPrice = mm.Pair.MinPrice
    }
    if mm.Pair.MaxPrice > 0 && marketPrice > mm.Pair.MaxPrice {
        marketPrice = mm.Pair.MaxPrice
    }

    // 4. Отменяем старые открытые ордера
    mm.cancelOpenOrders()

    // 5. Размещаем новые ордера
    ordersPlaced := mm.placeLevelOrders(marketPrice)

    // 6. Обновляем время выполнения
    UpdateBotPairLastExecuted(mm.Pair.ID)

    log.Printf("[bot] %s market updated at %.2f (%d orders placed)",
        mm.Pair.PairSymbol, marketPrice, ordersPlaced)
}

func (mm *MarketMaker) placeLevelOrders(midPrice float64) int {
    levels := mm.Pair.Levels
    if levels <= 0 {
        levels = 1
    }

    spread := mm.Pair.Spread / 100
    orderSize := mm.Pair.OrderSize
    ordersPlaced := 0

    for i := 1; i <= levels; i++ {
        levelSpread := spread * float64(i)
        bidPrice := midPrice * (1 - levelSpread)
        askPrice := midPrice * (1 + levelSpread)

        sizeVariation := 0.8 + rand.Float64()*0.4
        levelSize := orderSize * sizeVariation

        // Размещаем bid ордер
        orderUUID, err := mm.Client.PlaceOrder(mm.Pair.PairSymbol, "buy", levelSize, bidPrice)
        if err == nil {
            mm.activeOrders[orderUUID] = "buy"
            ordersPlaced++
        }

        // Размещаем ask ордер
        orderUUID, err = mm.Client.PlaceOrder(mm.Pair.PairSymbol, "sell", levelSize, askPrice)
        if err == nil {
            mm.activeOrders[orderUUID] = "sell"
            ordersPlaced++
        }

        log.Printf("[bot] %s Level %d: BUY @ %.2f (%.6f), SELL @ %.2f (%.6f)",
            mm.Pair.PairSymbol, i, bidPrice, levelSize, askPrice, levelSize)
    }

    return ordersPlaced
}

func (mm *MarketMaker) cancelOpenOrders() {
    orders, err := mm.Client.GetUserOrders(mm.Pair.PairSymbol)
    if err != nil {
        log.Printf("[bot] %s error getting open orders: %v", mm.Pair.PairSymbol, err)
        return
    }

    for _, order := range orders {
        if orderUUID, ok := order["order_id"].(string); ok {
            if err := mm.Client.CancelOrder(orderUUID); err != nil {
                log.Printf("[bot] %s error canceling order %s: %v",
                    mm.Pair.PairSymbol, orderUUID, err)
            } else {
                delete(mm.activeOrders, orderUUID)
            }
        }
    }
}

