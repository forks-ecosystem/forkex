-- Расширенная структура для развития

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    api_key VARCHAR(100),
    api_secret VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trading_strategies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    config_schema JSONB,
    is_available BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_pairs (
    id SERIAL PRIMARY KEY,
    pair_symbol VARCHAR(20) NOT NULL UNIQUE,
    base_currency VARCHAR(10) NOT NULL,
    quote_currency VARCHAR(10) NOT NULL,
    spread DECIMAL(5, 2) DEFAULT 0.5,
    order_size DECIMAL(20, 8) DEFAULT 0.01,
    min_price DECIMAL(20, 8) DEFAULT 0,
    max_price DECIMAL(20, 8) DEFAULT 0,
    levels INTEGER DEFAULT 3,
    is_active BOOLEAN DEFAULT true,
    update_rate INTEGER DEFAULT 30,
    max_orders INTEGER DEFAULT 10,
    max_position DECIMAL(20, 8) DEFAULT 0,
    bot_user_id INTEGER REFERENCES users(id),
    strategy_id INTEGER REFERENCES trading_strategies(id),
    strategy_params JSONB DEFAULT '{}',
    last_executed TIMESTAMP,
    total_volume DECIMAL(20, 8) DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    total_profit DECIMAL(20, 8) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS market_prices (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    source VARCHAR(50),
    volume_24h DECIMAL(20, 8),
    change_24h DECIMAL(10, 4),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    pair_id INTEGER REFERENCES bot_pairs(id),
    side VARCHAR(10) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    size DECIMAL(20, 8) NOT NULL,
    status VARCHAR(20) DEFAULT 'open',
    accepted BOOLEAN DEFAULT false,
    accepted_amount DECIMAL(20, 8) DEFAULT 0,
    symbol VARCHAR(20) NOT NULL,
    order_id VARCHAR(100) UNIQUE NOT NULL,
    fee DECIMAL(20, 8) DEFAULT 0,
    fee_currency VARCHAR(10),
    profit_loss DECIMAL(20, 8),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_logs (
    id SERIAL PRIMARY KEY,
    bot_pair_id INTEGER REFERENCES bot_pairs(id),
    user_id INTEGER REFERENCES users(id),
    level VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    context JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_metrics (
    id SERIAL PRIMARY KEY,
    bot_pair_id INTEGER REFERENCES bot_pairs(id),
    metric_name VARCHAR(50) NOT NULL,
    metric_value JSONB NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategy_history (
    id BIGSERIAL PRIMARY KEY,
    strategy_id INTEGER NOT NULL REFERENCES bot_configs(id) ON DELETE CASCADE,
    bot_user_id INTEGER NOT NULL DEFAULT 0,
    version VARCHAR(32) NOT NULL DEFAULT '',
    session_id VARCHAR(64) NOT NULL DEFAULT '',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event VARCHAR(32) NOT NULL,
    state VARCHAR(64) NOT NULL DEFAULT '',
    symbol VARCHAR(32) NOT NULL DEFAULT '',
    timeframe VARCHAR(16) NOT NULL DEFAULT '',
    price NUMERIC(24, 10) NOT NULL DEFAULT 0,
    volume NUMERIC(24, 10) NOT NULL DEFAULT 0,
    signal VARCHAR(64) NOT NULL DEFAULT '',
    action VARCHAR(64) NOT NULL DEFAULT '',
    order_id VARCHAR(100) NOT NULL DEFAULT '',
    position_id VARCHAR(64) NOT NULL DEFAULT '',
    result VARCHAR(64) NOT NULL DEFAULT '',
    pnl NUMERIC(24, 10) NOT NULL DEFAULT 0,
    context JSONB NOT NULL DEFAULT '{}',
    comment TEXT NOT NULL DEFAULT '',
    created_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Индексы
CREATE INDEX idx_strategy_history_strategy_time ON strategy_history(strategy_id, timestamp DESC);
CREATE INDEX idx_strategy_history_event ON strategy_history(event);
CREATE INDEX idx_bot_pairs_user ON bot_pairs(bot_user_id);
CREATE INDEX idx_bot_pairs_strategy ON bot_pairs(strategy_id);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
CREATE INDEX idx_orders_pair_created ON orders(pair_id, created_at);
CREATE INDEX idx_market_prices_symbol_time ON market_prices(symbol, updated_at);
CREATE INDEX idx_bot_logs_created ON bot_logs(created_at);
CREATE INDEX idx_bot_metrics_pair_time ON bot_metrics(bot_pair_id, recorded_at);

-- Тестовые данные
INSERT INTO users (username, email, is_active) VALUES
    ('trader1', 'trader1@example.com', true),
    ('trader2', 'trader2@example.com', true),
    ('admin', 'admin@forkex.com', true)
ON CONFLICT DO NOTHING;

INSERT INTO trading_strategies (name, description, config_schema) VALUES
    ('market_maker', 'Market Making Strategy', '{"spread": "number", "levels": "integer", "order_size": "number"}'),
    ('arbitrage', 'Arbitrage Strategy', '{"threshold": "number", "exchanges": "array"}'),
    ('trend_following', 'Trend Following Strategy', '{"period": "integer", "threshold": "number"}')
ON CONFLICT DO NOTHING;

INSERT INTO bot_pairs (pair_symbol, base_currency, quote_currency, bot_user_id, strategy_id) VALUES
    ('BTC/USDT', 'BTC', 'USDT', 1, 1),
    ('ETH/USDT', 'ETH', 'USDT', 1, 1),
    ('BNB/USDT', 'BNB', 'USDT', 2, 1),
    ('SOL/USDT', 'SOL', 'USDT', 2, 3)
ON CONFLICT DO NOTHING;

INSERT INTO market_prices (symbol, price, source) VALUES
    ('BTC/USDT', 45000.00, 'forkex'),
    ('ETH/USDT', 3000.00, 'forkex'),
    ('BNB/USDT', 400.00, 'forkex'),
    ('SOL/USDT', 100.00, 'forkex')
ON CONFLICT DO NOTHING;
