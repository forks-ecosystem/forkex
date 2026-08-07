package main

import (
    "context"
    "log"
    "fmt"
    "os"
    "os/signal"
    "encoding/json"
    "syscall"
    "time"

    "github.com/ixbaseANT/bot/internal/bot"
    "github.com/ixbaseANT/bot/internal/config"
    "github.com/ixbaseANT/bot/internal/database"
)

func main() {
    log.Println("🚀 Forkex Trading Bot starting...")

    // Загрузка конфигурации
    cfg, err := config.Load()
    if err != nil {
	log.Fatalf("❌ Failed to load config: %v", err)
    }
    // Подключение к БД (теперь на pgxpool)
    dbConn, err := database.New(cfg.Database.DSN)
    if err != nil {
	log.Fatalf("❌ Failed to connect to database: %v", err)
    }
    defer dbConn.Close()
/*
    defer func() {
	if err := dbConn.Close(); err != nil {
	    log.Printf("⚠️ Error closing database connection: %v", err)
	} else {
	    log.Println("Database connection closed gracefully")
	}
    }()
*/
    // Создание менеджера ботов
    manager := bot.NewBotManager(cfg, dbConn)
    // Запуск API сервера (раскомментировать когда готово)
    // api := bot.NewBotAPI(manager, dbConn)  // ← если API в пакете bot, а не database
    // go api.Start("8082")

    // Запуск всех активных ботов из БД
    if err := startAllActiveBotsFromDB(manager, dbConn); err != nil {
	log.Printf("⚠️ Failed to start some bots from DB: %v", err)
    }
    // Обработка сигналов завершения
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    // Запуск мониторинга статуса (heartbeat)
    go monitorStatus(manager)
    log.Println("✅ Bot manager started successfully")
    log.Println("   Press Ctrl+C to stop")
    // Ожидание сигнала
    <-sigChan
    log.Println("🛑 Shutdown signal received")
    // Graceful shutdown
    shutdownAllBots(manager)
    log.Println("👋 Bot shutdown complete")
}
// startAllActiveBotsFromDBDirect использует database.Database напрямую
func startAllActiveBotsFromDB(manager *bot.BotManager, db database.Database) error {
    ctx := context.Background()
    const query = `
        SELECT id, bot_user_id, name, strategy, parameters
        FROM bot_configs
        WHERE is_active = true
        ORDER BY created_at DESC
    `
    rows, err := db.Query(ctx, query)
    if err != nil {
        return fmt.Errorf("query active bot configs: %w", err)
    }
    defer rows.Close()
    var startedCount int
    for rows.Next() {
        var (
            id        int
            botUserID int
            name      string
            strategy  json.RawMessage   // ← лучше []byte → json.RawMessage
            params    json.RawMessage
        )
        if err := rows.Scan(&id, &botUserID, &name, &strategy, &params); err != nil {
            log.Printf("Failed to scan bot config (id likely %d): %v", id, err)
            continue
        }
        log.Printf("Found active bot: ID=%d, Name=%q, UserID=%d", id, name, botUserID)
        if err := manager.StartBot(botUserID, id); err != nil {
            log.Printf("Failed to start bot %d (%s): %v", id, name, err)
            continue
        }
        startedCount++
        log.Printf("Started bot: %s (ID: %d)", name, id)
    }
    if err := rows.Err(); err != nil {
        return fmt.Errorf("rows iteration error: %w", err)
    }
    log.Printf("Total active bots: %d, successfully started: %d", startedCount, startedCount)
    return nil
}

// shutdownAllBots останавливает все активные боты
func shutdownAllBots(manager *bot.BotManager) {
    activeBots := manager.GetActiveBots()
    log.Printf("🛑 Stopping %d active bots...", len(activeBots))
    for _, activeBot := range activeBots {
        if activeBot != nil {
            stats := activeBot.GetStats()
            info := activeBot.GetInfo()
            log.Printf("   Stopping bot: %s (ConfigID: %d)",
                info["bot_name"], stats.ConfigID)
            activeBot.Stop()
        }
    }
}
// monitorStatus периодически проверяет статус ботов
func monitorStatus(manager *bot.BotManager) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for range ticker.C {
        activeBots := manager.GetActiveBots()
        log.Printf("💓 [heartbeat] %d active bots", len(activeBots))
        // Выводим детальную информацию о каждом боте
        for _, botInstance := range activeBots {
            if botInstance == nil {
                continue
            }
            stats := botInstance.GetStats()
            info := botInstance.GetInfo()
            log.Printf("   🤖 %s (Strategy: %s)",
                info["bot_name"], info["strategy"])
            log.Printf("      Active: %v, Runtime: %ds, Orders: %d, P/L: %.2f",
                info["is_active"], stats.ActiveTime,
                stats.TotalOrders, stats.TotalProfit)
            // Дополнительная информация из конфигурации
            if symbol, ok := info["symbol"]; ok {
                log.Printf("      Pair: %s", symbol)
            }
        }
        // Общая статистика
        totalOrders := 0
        totalActiveTime := int64(0)
        totalProfit := 0.0
        for _, botInstance := range activeBots {
            if botInstance == nil {
                continue
            }
            stats := botInstance.GetStats()
            totalOrders += stats.TotalOrders
            totalActiveTime += stats.ActiveTime
            totalProfit += stats.TotalProfit
        }
        log.Printf("   📈 Total: %d orders, %.2f P/L, %d seconds of activity",
            totalOrders, totalProfit, totalActiveTime)
        // Можно добавить проверку на "зависшие" боты
        checkForStalledBots(manager)
    }
}

// checkForStalledBots проверяет боты, которые не обновлялись слишком долго
func checkForStalledBots(manager *bot.BotManager) {
    // Реализуйте логику проверки, если нужно
    // Например, перезапуск ботов, которые не обновлялись более 5 минут
}

