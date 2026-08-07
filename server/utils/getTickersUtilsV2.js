// server/utils/getTickersUtilsV2.js (расширенная версия)
'use strict';

const { Pair, Coin } = require('../db/models');
const moment = require('moment');

// Простой in-memory кеш
let tickerCache = {
    data: null,
    timestamp: 0,
    ttl: 3000 // 3 секунды
};

// Базовые цены криптовалют (можно обновлять из внешнего источника)
const BASE_PRICES = {
    'btc': { price: 95000, volatility: 0.02 },
    'eth': { price: 3200, volatility: 0.03 },
    'xht': { price: 0.55, volatility: 0.05 },
    'usdt': { price: 1, volatility: 0.001 },
    'usd': { price: 1, volatility: 0.001 },
    'eur': { price: 0.92, volatility: 0.002 },
    'rub': { price: 90, volatility: 0.005 },
    'bnb': { price: 600, volatility: 0.025 },
    'sol': { price: 200, volatility: 0.04 },
    'ada': { price: 0.45, volatility: 0.035 }
};

/**
 * Получение тикеров с интеллектуальным кешированием
 */
const getTickersUtils = async (forceRefresh = false) => {
    const now = Date.now();
    
    // Возвращаем кешированные данные если они свежие
    if (!forceRefresh && 
        tickerCache.data && 
        (now - tickerCache.timestamp) < tickerCache.ttl) {
        console.log('Returning cached tickers');
        return tickerCache.data;
    }
    
    console.log('Generating fresh ticker data...');
    
    try {
        // Получаем все активные пары
        const pairs = await Pair.findAll({
            include: [{
                model: Coin,
                as: 'base_coin',
                attributes: ['symbol', 'name']
            }, {
                model: Coin,
                as: 'quote_coin',
                attributes: ['symbol', 'name']
            }],
            where: { active: true, is_public: true }
        });
        const tickers = {};
        const timestamp = new Date().toISOString();
        // Генерируем тикеры для каждой пары
        for (const pair of pairs) {
            const symbol = pair.name || `${pair.base_coin.symbol}-${pair.quote_coin.symbol}`;
            tickers[symbol] = generateTickerData(symbol, pair, timestamp);
        }
        // Обновляем кеш
        tickerCache = {
            data: tickers,
            timestamp: now,
            ttl: 3000
        };
        return tickers;
    } catch (error) {
        console.error('Error generating tickers:', error.message);
        // Возвращаем базовые тикеры при ошибке
        return getBasicTickers();
    }
};

/**
 * Генерация данных тикера для пары
 */
function generateTickerData(symbol, pair, timestamp) {
    const [base, quote] = symbol.toLowerCase().split('-');
    // Получаем базовые цены
    const baseInfo = BASE_PRICES[base] || { price: 10 + Math.random() * 100, volatility: 0.05 };
    const quoteInfo = BASE_PRICES[quote] || { price: 1, volatility: 0.01 };
    // Рассчитываем теоретическую цену
    const theoreticalPrice = baseInfo.price / quoteInfo.price;
    // Генерируем реалистичные цены с волатильностью
    const { open, high, low, last, volume } = generatePriceData(
        theoreticalPrice, 
        baseInfo.volatility,
        symbol
    );
    const priceChange = ((last - open) / open * 100);
    const avgPrice = (high + low) / 2;
    return {
        symbol: symbol,
        last: last.toFixed(8),
        high: high.toFixed(8),
        low: low.toFixed(8),
        open: open.toFixed(8),
        close: last.toFixed(8),
        volume: volume.toFixed(2),
        avg_price: avgPrice.toFixed(8),
        price_change: priceChange.toFixed(2) + '%',
        timestamp: timestamp
    };
}

/**
 * Генерация реалистичных ценовых данных
 */
function generatePriceData(basePrice, volatility, symbol) {
    // Начальная цена (open)
    const openPrice = basePrice * (1 + (Math.random() * volatility * 2 - volatility));
    // Генерируем 24 "часовых" точки
    const hours = 24;
    let currentPrice = openPrice;
    let high = openPrice;
    let low = openPrice;
    for (let i = 0; i < hours; i++) {
        // Случайное движение цены
        const change = (Math.random() * volatility * 2 - volatility);
        currentPrice = currentPrice * (1 + change);
        if (currentPrice > high) high = currentPrice;
        if (currentPrice < low) low = currentPrice;
    }
    // Последняя цена (last)
    const lastPrice = currentPrice;
    // Объем в зависимости от пары
    let volumeMultiplier = 1;
    if (symbol.includes('btc')) volumeMultiplier = 1000;
    else if (symbol.includes('eth')) volumeMultiplier = 5000;
    else if (symbol.includes('usdt')) volumeMultiplier = 10000;
    const volume = basePrice * volumeMultiplier * (0.5 + Math.random());
    return {
        open: openPrice,
        high: high,
        low: low,
        last: lastPrice,
        volume: volume
    };
}
/**
 * Базовые тикеры (fallback)
 */
function getBasicTickers() {
    const timestamp = new Date().toISOString();
    
    return {
        'btc-usdt': {
            symbol: 'btc-usdt',
            last: '95000.01',
            high: '98000.50',
            low: '92000.25',
            open: '94000.01',
            close: '95000.01',
            volume: '1250.5',
            avg_price: '95200.75',
            price_change: '1.06%',
            timestamp: timestamp
        },
        'eth-usdt': {
            symbol: 'eth-usdt',
            last: '3200.50',
            high: '3350.75',
            low: '3100.25',
            open: '3150.00',
            close: '3200.50',
            volume: '8500.2',
            avg_price: '3225.30',
            price_change: '1.60%',
            timestamp: timestamp
        }
    };
}

/**
 * Функция для обновления базовых цен (можно вызывать периодически)
 */
async function updateBasePrices() {
    try {
        // Здесь можно добавить логику получения актуальных цен
        // из внешнего API (например, CoinGecko, Binance и т.д.)
        console.log('Base prices updated');
    } catch (error) {
        console.error('Error updating base prices:', error.message);
    }
}

module.exports = { 
    getTickersUtils,
    updateBasePrices,
    getBasicTickers
};
