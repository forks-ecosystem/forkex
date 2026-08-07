-- =====================================================
-- SEED: Reset coins, pairs, balances, address books
-- ПРАВИЛЬНЫЙ ПОРЯДОК: pairs → coins → balances → address_books
-- =====================================================

-- 1. СНАЧАЛА УДАЛЯЕМ ЗАВИСИМЫЕ ТАБЛИЦЫ
DELETE FROM pairs;
DELETE FROM balances;
DELETE FROM user_address_books;
DELETE FROM coins;

-- 2. ВСТАВЛЯЕМ COINS (без FOREIGN KEY конфликтов)
INSERT INTO coins (name, symbol, fullname, display_name, icon_id, status, active, verified, allow_deposit, allow_withdrawal, withdrawal_fee, min, max, increment, increment_unit, code, type, network, standard, issuer, is_risky, is_public, created_at, updated_at) VALUES
('Bitcoin',      'btc',  'Bitcoin',        'Bitcoin',        'BTC_ICON',  true, true, true, true, true, 0.0005,    0.0001,     100,        0.00000001, 0.00000001, 'BTC',  'blockchain', 'btc',  NULL,       'HollaEx',  false, true, NOW(), NOW()),
('Ethereum',     'eth',  'Ethereum',       'Ethereum',       'ETH_ICON',  true, true, true, true, true, 0.005,     0.001,      1000,       0.00000001, 0.00000001, 'ETH',  'blockchain', 'eth',  NULL,       'HollaEx',  false, true, NOW(), NOW()),
('Solana',       'sol',  'Solana',         'Solana',         'SOL_ICON',  true, true, true, true, true, 0.01,      0.01,       10000,      0.00000001, 0.00000001, 'SOL',  'blockchain', 'sol',  NULL,       'HollaEx',  false, true, NOW(), NOW()),
('Tron',         'trx',  'Tron',           'Tron',           'TRX_ICON',  true, true, true, true, true, 1,         10,         10000000,   0.000001,   0.000001,   'TRX',  'blockchain', 'trx',  NULL,       'HollaEx',  false, true, NOW(), NOW()),
('Tether',       'usdt', 'Tether',         'Tether USDT',    'USDT_ICON', true, true, true, true, true, 1,         1,          1000000,    0.000001,   0.000001,   'USDT', 'blockchain', 'eth',  'ERC20',    'Tether',   false, true, NOW(), NOW()),
('HollaEx Token','xht',  'HollaEx Token',  'HollaEx Token',  'XHT_ICON',  true, true, true, true, true, 0.5,       0.5,        100000,     0.000001,   0.000001,   'XHT',  'blockchain', 'eth',  'ERC20',    'HollaEx',  false, true, NOW(), NOW()),
('Gor',          'gor',  'Gor',            'Gor',            'GOR_ICON',  true, true, true, true, true, 0.01,      0.01,       100000,     0.00000001, 0.00000001, 'GOR',  'blockchain', 'gor',  NULL,       'HollaEx',  false, true, NOW(), NOW()),
('Kaspa',        'kas',  'Kaspa',          'Kaspa',          'KAS_ICON',  true, true, true, true, true, 0.1,       0.1,        1000000,    0.00000001, 0.00000001, 'KAS',  'blockchain', 'kas',  NULL,       'Kaspa',    false, true, NOW(), NOW());

-- 3. ВСТАВЛЯЕМ PAIRS (после COINS, т.к. нужны id)
INSERT INTO pairs (base_coin_id, quote_coin_id, pair_base, pair_2, symbol, name, active, status, taker_fees, maker_fees, min_size, max_size, increment_size, increment_price, is_public, circuit_breaker, created_at, updated_at) VALUES
((SELECT id FROM coins WHERE symbol='btc'),  (SELECT id FROM coins WHERE symbol='usdt'), 'btc',  'usdt', 'btc-usdt',  'BTC/USDT',  true, 'active', 0.001, 0.0005, 0.0001,   100,       0.0001,   0.01,     true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='eth'),  (SELECT id FROM coins WHERE symbol='usdt'), 'eth',  'usdt', 'eth-usdt',  'ETH/USDT',  true, 'active', 0.001, 0.0005, 0.001,    1000,      0.001,    0.01,     true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='sol'),  (SELECT id FROM coins WHERE symbol='usdt'), 'sol',  'usdt', 'sol-usdt',  'SOL/USDT',  true, 'active', 0.001, 0.0005, 0.01,     10000,     0.01,     0.01,     true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='trx'),  (SELECT id FROM coins WHERE symbol='usdt'), 'trx',  'usdt', 'trx-usdt',  'TRX/USDT',  true, 'active', 0.001, 0.0005, 10,       1000000,   1,        0.0001,   true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='xht'),  (SELECT id FROM coins WHERE symbol='usdt'), 'xht',  'usdt', 'xht-usdt',  'XHT/USDT',  true, 'active', 0.001, 0.0005, 0.5,      100000,    0.5,      0.01,     true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='gor'),  (SELECT id FROM coins WHERE symbol='usdt'), 'gor',  'usdt', 'gor-usdt',  'GOR/USDT',  true, 'active', 0.001, 0.0005, 0.01,     100000,    0.01,     0.01,     true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='kas'),  (SELECT id FROM coins WHERE symbol='usdt'), 'kas',  'usdt', 'kas-usdt',  'KAS/USDT',  true, 'active', 0.001, 0.0005, 0.1,      1000000,   0.1,      0.01,     true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='btc'),  (SELECT id FROM coins WHERE symbol='eth'),  'btc',  'eth',  'btc-eth',   'BTC/ETH',   true, 'active', 0.001, 0.0005, 0.0001,   100,       0.0001,   0.01,     true, true, NOW(), NOW()),
((SELECT id FROM coins WHERE symbol='eth'),  (SELECT id FROM coins WHERE symbol='btc'),  'eth',  'btc',  'eth-btc',   'ETH/BTC',   true, 'active', 0.001, 0.0005, 0.001,    1000,      0.001,    0.00001,  true, true, NOW(), NOW());

-- 4. ВСТАВЛЯЕМ BALANCES
DELETE FROM balances WHERE user_id IN (58, 57, 9);

INSERT INTO balances (user_id, currency, balance, available, locked, updated_at) VALUES
(58, 'btc',  0.5,     0.5,     0, NOW()),
(58, 'eth',  5.0,     5.0,     0, NOW()),
(58, 'usdt', 10000,   10000,   0, NOW()),
(58, 'sol',  50,      50,      0, NOW()),
(58, 'trx',  5000,    5000,    0, NOW()),
(58, 'xht',  100,     100,     0, NOW()),
(58, 'gor',  200,     200,     0, NOW()),
(58, 'kas',  1000,    1000,    0, NOW()),
(57, 'btc',  0.2,     0.2,     0, NOW()),
(57, 'eth',  2.0,     2.0,     0, NOW()),
(57, 'usdt', 5000,    5000,    0, NOW()),
(57, 'sol',  20,      20,      0, NOW()),
(57, 'trx',  3000,    3000,    0, NOW()),
(57, 'xht',  50,      50,      0, NOW()),
(57, 'gor',  100,     100,     0, NOW()),
(57, 'kas',  500,     500,     0, NOW()),
(9,  'btc',  0.1,     0.1,     0, NOW()),
(9,  'eth',  1.0,     1.0,     0, NOW()),
(9,  'usdt', 2000,    2000,    0, NOW()),
(9,  'sol',  10,      10,      0, NOW()),
(9,  'trx',  1000,    1000,    0, NOW()),
(9,  'xht',  25,      25,      0, NOW()),
(9,  'gor',  50,      50,      0, NOW()),
(9,  'kas',  200,     200,     0, NOW());

-- 5. USER ADDRESS BOOKS
DELETE FROM user_address_books WHERE user_id IN (58, 57, 9);

INSERT INTO user_address_books (user_id, addresses, created_at, updated_at) VALUES
(58, '[{"network":"btc","address":"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa","label":"BTC main wallet","currency":"btc","created_at":"2026-06-10T00:00:00.000Z"},{"network":"eth","address":"0x32Be343B94f860124dC4fEe278FDCBD38C102D88","label":"ETH main wallet","currency":"eth","created_at":"2026-06-10T00:00:00.000Z"}]', NOW(), NOW()),
(57, '[{"network":"btc","address":"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq","label":"BTC savings","currency":"btc","created_at":"2026-06-10T00:00:00.000Z"},{"network":"usdt","address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","label":"USDT TRC20","currency":"usdt","created_at":"2026-06-10T00:00:00.000Z"}]', NOW(), NOW()),
(9,  '[{"network":"eth","address":"0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18","label":"ETH test","currency":"eth","created_at":"2026-06-10T00:00:00.000Z"}]', NOW(), NOW());

-- 6. ДОБАВЛЯЕМ LBTC (LegacyCoin)
INSERT INTO coins (name, symbol, fullname, display_name, icon_id, status, active, verified, allow_deposit, allow_withdrawal, withdrawal_fee, min, max, increment, increment_unit, code, type, network, standard, issuer, is_risky, is_public, created_at, updated_at) VALUES
('LegacyCoin',   'lbtc', 'LegacyCoin',     'LegacyCoin',     'LBTC_ICON', true, true, true, true, true, 0.01,      0.1,       1000,       0.00000001, 0.00000001, 'LBTC', 'blockchain', 'lbtc', NULL,       'LegacyCore', false, true, NOW(), NOW());

-- 7. ДОБАВЛЯЕМ ПАРУ С LBTC
INSERT INTO pairs (base_coin_id, quote_coin_id, pair_base, pair_2, symbol, name, active, status, taker_fees, maker_fees, min_size, max_size, increment_size, increment_price, is_public, circuit_breaker, created_at, updated_at) VALUES
((SELECT id FROM coins WHERE symbol='lbtc'), (SELECT id FROM coins WHERE symbol='usdt'), 'lbtc', 'usdt', 'lbtc-usdt', 'LBTC/USDT', true, 'active', 0.001, 0.0005, 0.1, 1000, 0.1, 0.01, true, true, NOW(), NOW());

-- 8. БАЛАНСЫ ДЛЯ LBTC
INSERT INTO balances (user_id, currency, balance, available, locked, updated_at) VALUES
(58, 'lbtc', 100, 100, 0, NOW()),
(57, 'lbtc', 50,  50,  0, NOW()),
(9,  'lbtc', 25,  25,  0, NOW());