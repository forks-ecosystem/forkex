package order

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "strings"
    "time"

    "github.com/google/uuid"
    "github.com/ixbaseANT/bot/internal/database"
    "github.com/ixbaseANT/bot/internal/models"
)

// OrderRepository реализует OrderManager
type OrderRepository struct {
    db       database.Database
    recorder HistoryRecorder
}

// NewOrderRepository создает новый репозиторий
func NewOrderRepository(db database.Database) *OrderRepository {
    return &OrderRepository{db: db}
}

// recordOrderEvent пишет событие ордера в журнал стратегий (безопасно при отсутствии recorder)
func (r *OrderRepository) recordOrderEvent(order OrderData, event models.StrategyEvent) {
    if r.recorder == nil {
        return
    }
    err := r.recorder.RecordEvent(context.Background(), models.StrategyHistory{
        StrategyID: order.ConfigID,
        BotUserID:  order.BotUserID,
        Event:      event,
        Symbol:     order.Symbol,
        Price:      order.Price,
        Volume:     order.Quantity,
        OrderID:    order.OrderID,
    })
    if err != nil {
        log.Printf("Failed to record order event %s for %s: %v", event, order.OrderID, err)
    }
}

// recordCanceledEvent пишет событие отмены ордера, дозагружая данные ордера
func (r *OrderRepository) recordCanceledEvent(orderID string) {
    if r.recorder == nil {
        return
    }
    order, err := r.GetOrderByID(orderID)
    if err != nil {
        order = &OrderData{OrderID: orderID}
    }
    r.recordOrderEvent(*order, models.EventOrderCanceled)
}

// SaveOrder сохраняет ордер в БД с полной совместимостью
func (r *OrderRepository) SaveOrder(order OrderData) (string, error) {
    // Генерируем уникальный ID если не задан
    if order.OrderID == "" {
        order.OrderID = uuid.New().String()
    }

    // Устанавливаем временные метки
    now := time.Now()
    if order.CreatedAt.IsZero() {
        order.CreatedAt = now
    }
    order.UpdatedAt = now
    
    // Для совместимости: user_id = bot_user_id (если не задан)
    if order.UserID == 0 {
        order.UserID = order.BotUserID
    }
    
    // Определяем символ для совместимости
    symbol := order.Symbol
    if symbol == "" {
        symbol = "BTCUSDT" // Значение по умолчанию
    }
    
    // Используем quantity как size, если size не задан
    size := order.Size
    if size == 0 && order.Quantity > 0 {
        size = order.Quantity
    }
    
    orderType := order.Type
    if orderType == "" {
        orderType = "limit"
    }
    
    query := `
        INSERT INTO orders (
            user_id, pair_id, config_id, bot_user_id,
            symbol, side, type, price, size,
            status, accepted, accepted_amount, fee,
            order_id, execution_strategy, quantity,
            created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10, $11, $12, $13, $14, $15, $16,
                 $17, $18)
        RETURNING id
    `

    var orderID int
    err := r.db.QueryRow(context.Background(), query,
        order.UserID, order.PairID, order.ConfigID, order.BotUserID,
        symbol, order.Side, orderType, order.Price, size,
        order.Status, order.Accepted, order.AcceptedAmount, order.Fee,
        order.OrderID, order.ExecutionStrategy, order.Quantity,
        order.CreatedAt, order.UpdatedAt,
    ).Scan(&orderID)
    
    if err != nil {
        log.Printf("❌ Failed to save order: %v", err)
        log.Printf("   Order data: ConfigID=%d, BotUserID=%d, Symbol=%s, Side=%s, Price=%.2f",
            order.ConfigID, order.BotUserID, symbol, order.Side, order.Price)
        return "", fmt.Errorf("failed to save order: %v", err)
    }

    log.Printf("💾 Order saved: ID=%d, %s %s %.4f %s @ %.2f (ConfigID: %d)",
        orderID, order.OrderID, order.Side, order.Quantity, order.Symbol, order.Price, order.ConfigID)

    r.recordOrderEvent(order, models.EventOrderCreated)

    return order.OrderID, nil
}

// SaveOrderFromRequest сохраняет ордер из запроса
func (r *OrderRepository) SaveOrderFromRequest(req OrderRequest) (string, error) {
    orderData := req.ToOrderData()
    return r.SaveOrder(orderData)
}
// ToOrderData конвертирует запрос в OrderData
/*
func (r *OrderRequest) ToOrderData() OrderData {
    now := time.Now()
    return OrderData{
        ConfigID:          r.ConfigID,
        BotUserID:        r.BotUserID,
        PairID:           r.PairID,
        UserID:           r.BotUserID, // Для совместимости
        Symbol:           r.Symbol,
        Side:             r.Side,
        Type:             r.Type,
        Price:            r.Price,
        Quantity:         r.Quantity,
        Size:             r.Quantity, // Дублируем для совместимости
        Status:           "pending",
        Accepted:         false,
        AcceptedAmount:   0,
        Fee:              0,
        ExecutionStrategy: r.Strategy,
        ExecutionParams:  make(map[string]interface{}),
        Priority:         r.Priority,
        DistancePct:      r.DistancePct,
        Remarks:          r.Remarks,
        CreatedAt:        now,
        UpdatedAt:        now,
        FilledAt:         time.Time{}, // Пустое время
        CancelledAt:      time.Time{}, // Пустое время
    }
}
*/
// GetOrderByID получает ордер по ID
func (r *OrderRepository) GetOrderByID(orderID string) (*OrderData, error) {
    query := `
        SELECT 
            id, user_id, pair_id, config_id, bot_user_id,
            symbol, side, type, price, size,
            status, accepted, accepted_amount, fee,
            order_id, execution_strategy,
            created_at, updated_at, quantity
        FROM orders
        WHERE order_id = $1
    `
    
    var order OrderData
    
    err := r.db.QueryRow(context.Background(), query, orderID).Scan(
        &order.ID, &order.UserID, &order.PairID, &order.ConfigID, &order.BotUserID,
        &order.Symbol, &order.Side, &order.Type, &order.Price, &order.Size,
        &order.Status, &order.Accepted, &order.AcceptedAmount, &order.Fee,
        &order.OrderID, &order.ExecutionStrategy,
        &order.CreatedAt, &order.UpdatedAt, &order.Quantity,
    )

    if err != nil {
        return nil, err
    }

    if order.Quantity == 0 {
        order.Quantity = order.Size // Дублируем для совместимости
    }

    return &order, nil
}

// GetActiveOrders получает активные ордера для конфигурации
func (r *OrderRepository) GetActiveOrders(configID int) ([]OrderData, error) {
    query := `
        SELECT 
            id, user_id, pair_id, config_id, bot_user_id,
            symbol, side, type, price, size,
            status, accepted, accepted_amount, fee,
            order_id, execution_strategy,
            created_at, updated_at, quantity
        FROM orders
        WHERE config_id = $1
          AND status IN ('pending', 'open')
        ORDER BY created_at DESC
        LIMIT 50
    `

    rows, err := r.db.Query(context.Background(), query, configID)
    if err != nil {  
        return nil, err 
    }
    defer rows.Close()

    var orders []OrderData
    for rows.Next() {
        var order OrderData

        err := rows.Scan(
            &order.ID, &order.UserID, &order.PairID,
            &order.ConfigID, &order.BotUserID,
            &order.Symbol, &order.Side, &order.Type, &order.Price, &order.Size,
            &order.Status, &order.Accepted, &order.AcceptedAmount, &order.Fee,
            &order.OrderID, &order.ExecutionStrategy,
            &order.CreatedAt, &order.UpdatedAt,
            &order.Quantity,
        )
        if err != nil {
            log.Printf("Error scanning order: %v", err)
            continue
        }

        // Если quantity = 0, используем size
        if order.Quantity == 0 {
            order.Quantity = order.Size
        }

        orders = append(orders, order)
    }
    return orders, nil
}
// CancelOldOrders отменяет ордера старше указанного времени
func (r *OrderRepository) CancelOldOrders(configID int, maxAgeMinutes int) (int, error) {
    if maxAgeMinutes <= 0 {
        maxAgeMinutes = 30 // Значение по умолчанию: 30 минут
    }

    query := `
        UPDATE orders
        SET status = 'canceled',
            updated_at = NOW()
        WHERE config_id = $1
          AND status IN ('pending', 'open')
          AND created_at < NOW() - ($2 * INTERVAL '1 minute')
        RETURNING id, order_id, side, price, quantity
    `

    rows, err := r.db.Query(context.Background(), query, configID, maxAgeMinutes)
    if err != nil {
        return 0, fmt.Errorf("failed to cancel old orders: %v", err)
    }
    defer rows.Close()

    cancelledCount := 0
    var cancelledOrders []string
    for rows.Next() {
        var id int
        var orderID, side string
        var price, quantity float64
        if err := rows.Scan(&id, &orderID, &side, &price, &quantity); err == nil {
            cancelledCount++
            orderInfo := fmt.Sprintf("%s (%s %.4f @ %.2f)", orderID, side, quantity, price)
            cancelledOrders = append(cancelledOrders, orderInfo)
            r.recordOrderEvent(OrderData{
                ConfigID: configID,
                Symbol:   "",
                Side:     side,
                Price:    price,
                Quantity: quantity,
                OrderID:  orderID,
            }, models.EventOrderCanceled)
        }
    }

    if cancelledCount > 0 {
        log.Printf("Отменено %d старых ордеров (старше %d минут): %v",
            cancelledCount, maxAgeMinutes, cancelledOrders)
    }
    return cancelledCount, nil
}
// CancelOldOrdersByStrategy отменяет старые ордера определенной стратегии
func (r *OrderRepository) CancelOldOrdersByStrategy(strategy string, maxAgeMinutes int) (int, error) {
    if maxAgeMinutes <= 0 {
        maxAgeMinutes = 30
    }
    
    query := `
        UPDATE orders 
        SET status = 'canceled', 
            updated_at = NOW(),
            cancelled_at = NOW()
        WHERE bot_id > 0
          AND execution_strategy = $1
          AND status IN ('pending', 'open')
          AND created_at < NOW() - INTERVAL '$2 minutes'
        RETURNING id, order_id
    `
    
    rows, err := r.db.Query(context.Background(), query, strategy, maxAgeMinutes)
    if err != nil {
        return 0, fmt.Errorf("failed to cancel old orders by strategy: %v", err)
    }
    defer rows.Close()
    
    cancelledCount := 0
    for rows.Next() {
        var id int
        var orderID string
        if err := rows.Scan(&id, &orderID); err == nil {
            cancelledCount++
            log.Printf("Cancelled old order: ID=%d, OrderID=%s", id, orderID)
        }
    }
    
    return cancelledCount, nil
}
// UpdateOrderStatus обновляет статус ордера
func (r *OrderRepository) UpdateOrderStatus(orderID, status string, executedPrice float64) error {
    ctx := context.Background()
    
    // Проверяем, является ли orderID UUID
    var orderUUID uuid.UUID
    if parsed, err := uuid.Parse(orderID); err == nil {
        orderUUID = parsed
    } else {
        // Если не UUID, генерируем из строки
        orderUUID = uuid.NewSHA1(uuid.Nil, []byte(orderID))
    }
    log.Printf("======== orderUUID: %v", orderUUID)
    var query string
    if status == "filled" {
        // Сначала получаем данные ордера
        var orderData OrderData
        getQuery := `
            SELECT id, user_id, pair_id, config_id, bot_user_id,
                   symbol, side, type, price, quantity, size
            FROM orders WHERE order_id = $1
        `
        
        err := r.db.QueryRow(ctx, getQuery, orderID).Scan(
            &orderData.ID, &orderData.UserID, &orderData.PairID, &orderData.ConfigID, &orderData.BotUserID,
            &orderData.Symbol, &orderData.Side, &orderData.Type,
            &orderData.Price, &orderData.Quantity, &orderData.Size,
        )
        
        if err != nil {
            return fmt.Errorf("failed to get order data: %v", err)
        }
        orderData.OrderID = orderID
        
        // Обновляем статус ордера
        query = `
            UPDATE orders 
            SET status = $1, 
                accepted = true, 
                accepted_amount = quantity,
                updated_at = NOW()
            WHERE order_id = $2 AND status = 'open'
        `
        
        result, err := r.db.Exec(ctx, query, status, orderID)
        if err != nil {
            return fmt.Errorf("failed to update order status: %v", err)
        }
        
        // Проверяем, был ли обновлен ордер
        rowsAffected := result.RowsAffected()
        if rowsAffected == 0 {
            return fmt.Errorf("order not found or already updated: %s", orderID)
        }
        
        // Записываем сделку
        if err := r.RecordTrade(orderData, executedPrice); err != nil {
            log.Printf(" Failed to record trade for order %s: %v", orderID, err)
            // Продолжаем выполнение даже при ошибке записи сделки
        }

        orderData.Price = executedPrice
        r.recordOrderEvent(orderData, models.EventOrderFilled)

        return nil
    } else {
        query = `
            UPDATE orders 
            SET status = $1, 
                updated_at = NOW()
            WHERE order_id = $2
        `
        _, err := r.db.Exec(ctx, query, status, orderID)
        if err == nil && status == "canceled" {
            r.recordCanceledEvent(orderID)
        }
        return err
    }
}
func (r *OrderRepository) _UpdateOrderStatus(orderID, status string, executedPrice float64) error {
    ctx := context.Background()
    
    var query string
    if status == "filled" {
        // accepted_amount должно быть quantity, а не quantity * price
        query = `
            UPDATE orders 
            SET status = $1, 
                accepted = true, 
                accepted_amount = quantity,  -- ИСПРАВИТЬ: quantity а не quantity * price
                updated_at = NOW(),
                filled_at = NOW()
            WHERE order_id = $2 AND status = 'open'
        `
    } else {
        query = `
            UPDATE orders 
            SET status = $1, 
                updated_at = NOW()
            WHERE order_id = $2
        `
    }
    
    _, err := r.db.Exec(ctx, query, status, orderID)
    return err
}
func (r *OrderRepository) __UpdateOrderStatus(orderID, status string, filledQuantity float64) error {
    query := `
        UPDATE orders 
        SET status = $1,
            updated_at = $2
        WHERE order_id = $3
    `
    
    args := []interface{}{status, time.Now(), orderID}
    
    if status == "filled" {
        query = `
            UPDATE orders 
            SET status = $1,
                accepted = true,
                accepted_amount = $2,
                fee = size * price * 0.001, -- 0.1% комиссия
                updated_at = $3
            WHERE order_id = $4
        `
        args = []interface{}{status, filledQuantity, time.Now(), orderID}
    }
    
    result, err := r.db.Exec(context.Background(), query, args...)
    if err != nil {
        return err
    }
    
    rowsAffected := result.RowsAffected()
    if rowsAffected == 0 {
        return fmt.Errorf("order %s not found", orderID)
    }
    
    log.Printf("📝 Order %s updated to status: %s", orderID, status)
    return nil
}

// CancelOrder отменяет ордер
func (r *OrderRepository) CancelOrder(orderID string) error {
    query := `
        UPDATE orders
        SET status = 'canceled',
            updated_at = $1
        WHERE order_id = $2
          AND status IN ('pending', 'open')`

    result, err := r.db.Exec(context.Background(), query, time.Now(), orderID)
    if err != nil {
        return fmt.Errorf("failed to cancel order %s: %w", orderID, err)
    }

    rowsAffected := result.RowsAffected()
    if rowsAffected == 0 {
        return fmt.Errorf("order %s not found, already canceled, or not in cancelable state", orderID)
    }

    log.Printf("🛑 Order %s canceled at %v", orderID, time.Now().Format(time.RFC3339))

    r.recordCanceledEvent(orderID)
    return nil
}
// GetOrdersByConfig получает все ордера конфигурации
func (r *OrderRepository) GetOrdersByConfig(configID int, limit int) ([]OrderData, error) {
    query := `
        SELECT 
            id, user_id, pair_id, bot_id, config_id, bot_user_id,
            symbol, side, type, price, size,
            status, accepted, accepted_amount, fee,
            order_id, execution_strategy, execution_params,
            priority, distance_pct, remarks,
            created_at, updated_at
        FROM orders
        WHERE config_id = $1
        ORDER BY created_at DESC
        LIMIT $2
    `
    
    rows, err := r.db.Query(context.Background(), query, configID, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    
    var orders []OrderData
    for rows.Next() {
        var order OrderData
        var executionParamsJSON []byte
        
        err := rows.Scan(
            &order.ID, &order.UserID, &order.PairID, &order.BotID, &order.ConfigID, &order.BotUserID,
            &order.Symbol, &order.Side, &order.Type, &order.Price, &order.Size,
            &order.Status, &order.Accepted, &order.AcceptedAmount, &order.Fee,
            &order.OrderID, &order.ExecutionStrategy, &executionParamsJSON,
            &order.Priority, &order.DistancePct, &order.Remarks,
            &order.CreatedAt, &order.UpdatedAt,
        )
        if err != nil {
            log.Printf("Error scanning order: %v", err)
            continue
        }
        
        // Парсим JSON параметры
        if len(executionParamsJSON) > 0 {
            var params map[string]interface{}
            if err := json.Unmarshal(executionParamsJSON, &params); err == nil {
                order.ExecutionParams = params
            }
        }
        
        order.Quantity = order.Size
        orders = append(orders, order)
    }
    
    return orders, nil
}
func (r *OrderRepository) GetFilledOrders(configID int) ([]OrderData, error) {
    ctx := context.Background()
    
    query := `
        SELECT 
            id, user_id, pair_id, bot_id, config_id, bot_user_id,
            symbol, side, type, price, quantity, size,
            status, accepted, accepted_amount, fee,
            order_id, execution_strategy, execution_params,
            priority, distance_pct, remarks,
            created_at, updated_at, filled_at
        FROM orders 
        WHERE config_id = $1 AND status = 'filled'
        ORDER BY filled_at DESC
        LIMIT 100
    `
    
    rows, err := r.db.Query(ctx, query, configID)
    if err != nil {
        return nil, fmt.Errorf("failed to query filled orders: %v", err)
    }
    defer rows.Close()
    
    var orders []OrderData
    for rows.Next() {
        var order OrderData
        var executionParams []byte
        
        err := rows.Scan(
            &order.ID, &order.UserID, &order.PairID, &order.BotID, 
            &order.ConfigID, &order.BotUserID,
            &order.Symbol, &order.Side, &order.Type, 
            &order.Price, &order.Quantity, &order.Size,
            &order.Status, &order.Accepted, &order.AcceptedAmount, &order.Fee,
            &order.OrderID, &order.ExecutionStrategy, &executionParams,
            &order.Priority, &order.DistancePct, &order.Remarks,
            &order.CreatedAt, &order.UpdatedAt, &order.FilledAt,
        )
        
        if err != nil {
            log.Printf("Error scanning filled order: %v", err)
            continue
        }
        
        // Десериализуем execution_params если нужно
        if len(executionParams) > 0 {
            // Если execution_params хранится как JSON
            // order.ExecutionParams = parseJSON(executionParams)
        }
        
        orders = append(orders, order)
    }
    
    return orders, nil
}

// UpdateOrder обновляет ордер (полная замена)
func (r *OrderRepository) UpdateOrder(order OrderData) error {
    ctx := context.Background()
    
    query := `
        UPDATE orders 
        SET 
            status = $1,
            accepted = $2,
            accepted_amount = $3,
            fee = $4,
            updated_at = $5,
            filled_at = $6
        WHERE order_id = $7
    `
    
    _, err := r.db.Exec(ctx, query,
        order.Status,
        order.Accepted,
        order.AcceptedAmount,
        order.Fee,
        order.UpdatedAt,
        order.FilledAt,
        order.OrderID,
    )
    
    if err != nil {
        return fmt.Errorf("failed to update order: %v", err)
    }
    
    return nil
}
// RecordTrade записывает сделку в таблицу trades с учетом структуры HollaEx
func (r *OrderRepository) RecordTrade(orderData OrderData, executionPrice float64) error {
    ctx := context.Background()
    
    // Генерируем UUID для сделки и тейкера (так как у нас нет реального контрагента)
    makerOrderUUID, err := uuid.Parse(orderData.OrderID)
    if err != nil {
        // Если order_id не UUID, генерируем новый
        makerOrderUUID = uuid.New()
    }
    takerOrderUUID := uuid.New() // Для тейкера генерируем новый UUID
    
    // Рассчитываем комиссии (стандартные биржевые 0.1% для маркет-мейкера, 0.2% для тейкера)
    tradeValue := executionPrice * orderData.Quantity
    makerFee := tradeValue * 0.001 // 0.1%
    takerFee := tradeValue * 0.002 // 0.2%
    
    // Определяем fee coins в зависимости от пары
    var makerFeeCoin, takerFeeCoin string
    if orderData.Symbol == "BTCUSDT" {
        makerFeeCoin = "usdt" // USDT для мейкера
        takerFeeCoin = "btc"  // BTC для тейкера
    } else {
        makerFeeCoin = "usdt"
        takerFeeCoin = strings.ToLower(strings.TrimSuffix(orderData.Symbol, "USDT"))
    }
    
    query := `
        INSERT INTO trades (
            side, symbol, size, price,
            maker_order_id, taker_order_id, timestamp,
            maker_fee, taker_fee,
            maker_fee_coin, taker_fee_coin,
            quick, maker_id, taker_id,
            maker_network_id, taker_network_id,
            pair_id, created_at, updated_at,
            quantity, direction
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19,
            $20, $21
        )
        RETURNING id
    `
    
    now := time.Now()
    
    // Для системной сделки: наш бот = maker (маркет-мейкер), "система" = taker
    makerID := orderData.BotUserID
    takerID := 0 // 0 или system_id для системного исполнения
    
    var tradeID int
    err = r.db.QueryRow(ctx, query,
        orderData.Side,        // side
        orderData.Symbol,      // symbol
        orderData.Quantity,    // size (numeric(20,10))
        executionPrice,        // price (numeric(20,10))
        makerOrderUUID,        // maker_order_id (uuid)
        takerOrderUUID,        // taker_order_id (uuid)
        now,                   // timestamp
        makerFee,              // maker_fee (numeric(10,6))
        takerFee,              // taker_fee (numeric(10,6))
        makerFeeCoin,          // maker_fee_coin
        takerFeeCoin,          // taker_fee_coin
        true,                  // quick = true (быстрая сделка)
        makerID,               // maker_id
        takerID,               // taker_id
        1,                     // maker_network_id
        1,                     // taker_network_id
        orderData.PairID,      // pair_id
        now,                   // created_at
        now,                   // updated_at
        orderData.Quantity,    // quantity (numeric(18,8))
        orderData.Side,        // direction (same as side)
    ).Scan(&tradeID)
    
    if err != nil {
        return fmt.Errorf("failed to record trade: %v", err)
    }
    
    log.Printf(" Trade recorded: ID=%d, %s %.8f %s @ %.2f (fee: %.6f %s)", 
        tradeID, orderData.Side, orderData.Quantity, orderData.Symbol, 
        executionPrice, makerFee, makerFeeCoin)
    
    return nil
}
// GetTradeHistory возвращает историю сделок для конфига
func (r *OrderRepository) GetTradeHistory(configID int, limit int) ([]Trade, error) {
    ctx := context.Background()
    
    if limit <= 0 {
        limit = 50
    }
    
    query := `
        SELECT 
            t.id, t.side, t.symbol, t.size, t.price,
            t.maker_order_id, t.taker_order_id, t.timestamp,
            t.maker_fee, t.taker_fee, t.maker_fee_coin, t.taker_fee_coin,
            t.quick, t.maker_id, t.taker_id,
            t.maker_network_id, t.taker_network_id, t.pair_id,
            t.created_at, t.updated_at, t.quantity, t.direction, t.order_id
        FROM trades t
        JOIN orders o ON t.order_id::text = o.order_id OR t.maker_order_id::text = o.order_id
        WHERE o.config_id = $1
        ORDER BY t.timestamp DESC
        LIMIT $2
    `
    
    rows, err := r.db.Query(ctx, query, configID, limit)
    if err != nil {
        return nil, fmt.Errorf("failed to query trade history: %v", err)
    }
    defer rows.Close()
    
    var trades []Trade
    for rows.Next() {
        var trade Trade
        err := rows.Scan(
            &trade.ID, &trade.Side, &trade.Symbol, &trade.Size, &trade.Price,
            &trade.MakerOrderID, &trade.TakerOrderID, &trade.Timestamp,
            &trade.MakerFee, &trade.TakerFee, &trade.MakerFeeCoin, &trade.TakerFeeCoin,
            &trade.Quick, &trade.MakerID, &trade.TakerID,
            &trade.MakerNetworkID, &trade.TakerNetworkID, &trade.PairID,
            &trade.CreatedAt, &trade.UpdatedAt, &trade.Quantity, &trade.Direction, &trade.OrderID,
        )
        if err != nil {
            log.Printf("Error scanning trade: %v", err)
            continue
        }
        trades = append(trades, trade)
    }
    
    return trades, nil
}

// Trade структура для сделки
type Trade struct {
    ID              int       `json:"id"`
    Side            string    `json:"side"`
    Symbol          string    `json:"symbol"`
    Size            float64   `json:"size"`
    Price           float64   `json:"price"`
    MakerOrderID    uuid.UUID `json:"maker_order_id"`
    TakerOrderID    uuid.UUID `json:"taker_order_id"`
    Timestamp       time.Time `json:"timestamp"`
    MakerFee        float64   `json:"maker_fee"`
    TakerFee        float64   `json:"taker_fee"`
    MakerFeeCoin    string    `json:"maker_fee_coin"`
    TakerFeeCoin    string    `json:"taker_fee_coin"`
    Quick           bool      `json:"quick"`
    MakerID         int       `json:"maker_id"`
    TakerID         int       `json:"taker_id"`
    MakerNetworkID  int       `json:"maker_network_id"`
    TakerNetworkID  int       `json:"taker_network_id"`
    PairID          int       `json:"pair_id"`
    CreatedAt       time.Time `json:"created_at"`
    UpdatedAt       time.Time `json:"updated_at"`
    Quantity        float64   `json:"quantity"`
    Direction       string    `json:"direction"`
    OrderID         uuid.UUID `json:"order_id"`
}
// CalculatePnL рассчитывает прибыль/убыток по сделкам
func (r *OrderRepository) CalculatePnL(configID int) (map[string]float64, error) {
    ctx := context.Background()
    
    query := `
        SELECT 
            SUM(CASE WHEN t.side = 'buy' THEN t.price * t.quantity ELSE 0 END) as total_buy,
            SUM(CASE WHEN t.side = 'sell' THEN t.price * t.quantity ELSE 0 END) as total_sell,
            SUM(CASE WHEN t.side = 'buy' THEN t.quantity ELSE 0 END) as total_buy_qty,
            SUM(CASE WHEN t.side = 'sell' THEN t.quantity ELSE 0 END) as total_sell_qty,
            SUM(t.maker_fee) + SUM(t.taker_fee) as total_fees
        FROM trades t
        JOIN orders o ON t.order_id::text = o.order_id OR t.maker_order_id::text = o.order_id
        WHERE o.config_id = $1
    `
    
    var totalBuy, totalSell, totalBuyQty, totalSellQty, totalFees float64
    
    err := r.db.QueryRow(ctx, query, configID).Scan(
        &totalBuy, &totalSell, &totalBuyQty, &totalSellQty, &totalFees,
    )
    
    if err != nil {
        return nil, fmt.Errorf("failed to calculate PnL: %v", err)
    }
    
    result := map[string]float64{
        "total_buy":      totalBuy,
        "total_sell":     totalSell,
        "total_buy_qty":  totalBuyQty,
        "total_sell_qty": totalSellQty,
        "total_fees":     totalFees,
        "gross_profit":   totalSell - totalBuy,
        "net_profit":     totalSell - totalBuy - totalFees,
        "avg_buy_price":  0,
        "avg_sell_price": 0,
    }
    
    if totalBuyQty > 0 {
        result["avg_buy_price"] = totalBuy / totalBuyQty
    }
    if totalSellQty > 0 {
        result["avg_sell_price"] = totalSell / totalSellQty
    }
    
    return result, nil
}
