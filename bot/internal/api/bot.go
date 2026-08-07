// api/bot.go
package api

// Запуск бота
POST /api/v1/bots/start
{
    "bot_user_id": 1,
    "pair_id": 1,
    "strategy_id": 1,
    "config": {
        "spread": 0.5,
        "levels": 3
    }
}

// Запуск теста
POST /api/v1/bots/backtest
{
    "config_id": 1,
    "from": "2024-01-01",
    "to": "2024-01-31",
    "initial_capital": 10000
}

// Получение сравнения стратегий
GET /api/v1/analytics/compare?pair=BTC-USDT&strategies=market_maker_classic,aggressive_mm&period=7d
