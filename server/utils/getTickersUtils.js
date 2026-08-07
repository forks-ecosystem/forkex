// server/utils/getTickersUtils.js
'use strict';

const { Trade, Pair, Coin } = require('../db/models');
const { Op } = require('sequelize');
const moment = require('moment');

// Mock данные для демонстрации
const MOCK_TICKERS = {
    'btc-usdt': {
        symbol: 'btc-usdt',
        last: '95000.03',
        high: '98000.50',
        low: '92000.25',
        open: '94000.03',
        close: '95000.03',
        volume: '1250.5',
        avg_price: '95200.75',
        price_change: '1.06%',
        timestamp: new Date().toISOString()
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
        timestamp: new Date().toISOString()
    },
    'xht-usdt': {
        symbol: 'xht-usdt',
        last: '0.5500',
        high: '0.5800',
        low: '0.5200',
        open: '0.5300',
        close: '0.5500',
        volume: '500000',
        avg_price: '0.5450',
        price_change: '3.77%',
        timestamp: new Date().toISOString()
    }
};
// Добавим случайные колебания для реалистичности
function addRandomFluctuation(ticker) {
    const basePrice = parseFloat(ticker.last);
    const fluctuation = (Math.random() * 0.02) - 0.01; // ±1%
    const newPrice = basePrice * (1 + fluctuation);
    return {
        ...ticker,
        last: newPrice.toFixed(2),
        high: (parseFloat(ticker.high) * (1 + Math.random() * 0.005)).toFixed(2),
        low: (parseFloat(ticker.low) * (1 - Math.random() * 0.005)).toFixed(2),
        volume: (parseFloat(ticker.volume) * (1 + Math.random() * 0.1)).toFixed(1),
        price_change: ((newPrice - parseFloat(ticker.open)) / parseFloat(ticker.open) * 100).toFixed(2) + '%',
        timestamp: new Date().toISOString()
    };
}
/**
 * Получение тикеров с проверкой реальных данных
 */
const getTickersUtils = async () => {
    try {
        console.log('Fetching tickers from local database...');
        // Сначала проверяем реальные данные
        const hasRealData = await checkRealDataExists();
        if (!hasRealData) {
            console.log('No real trades found, returning empty tickers');
            return {};
        }
        // Если есть реальные данные, используем их
        return await getRealTickers();
    } catch (error) {
        console.error('Error in getTickersUtils:', error.message);
        return {};
    }
};
/**
 * Проверяет наличие реальных данных в базе
 */
async function checkRealDataExists() {
    try {
        const recentTrade = await Trade.findOne({
            where: {
                created_at: {
                    [Op.gte]: moment().subtract(90, 'days').toDate()
                }
            }
        });
        return !!recentTrade;
    } catch (error) {
        console.error('Error checking real data:', error.message);
        return false;
    }
}
/**
 * Получение реальных тикеров из базы данных
 */
async function getRealTickers() {
    const dayAgo = moment().subtract(24, 'hours').toDate();
    // Получаем все активные пары
    const pairs = await Pair.findAll({
        include: [{
            model: Coin,
            as: 'base_coin',
            attributes: ['symbol']
        }, {
            model: Coin,
            as: 'quote_coin',
            attributes: ['symbol']
        }],
        where: { active: true, is_public: true }
    });

    const tickers = {};
    for (const pair of pairs) {
        const symbol = (pair.symbol || `${pair.base_coin.symbol}-${pair.quote_coin.symbol}`).replace('/', '-').toLowerCase();
        try {
            const trades = await Trade.findAll({
                where: {
                    symbol,
                    created_at: {
                        [Op.gte]: moment().subtract(30, 'days').toDate()
                    }
                },
                order: [['created_at', 'ASC']],
                limit: 1000,
                raw: true
            });
            if (trades.length > 0) {
                // Используем реальные данные
                tickers[symbol] = calculateTickerFromTrades(trades, symbol);
            } else {
                // Используем mock для этой пары
                tickers[symbol] = getMockTickerForPair(symbol);
            }
        } catch (error) {
            console.error(`Error processing ${symbol}:`, error.message);
            tickers[symbol] = getMockTickerForPair(symbol);
        }
    }
    return tickers;
}
/**
 * Расчет тикера из реальных сделок
 */
function calculateTickerFromTrades(trades, symbol) {
    if (!trades || trades.length === 0) {
        return getMockTickerForPair(symbol);
    }
    let high = parseFloat(trades[0].price);
    let low = parseFloat(trades[0].price);
    let volume = 0;
    let totalValue = 0;
    trades.forEach(trade => {
        const price = parseFloat(trade.price);
        const size = parseFloat(trade.size || 0);
        if (price > high) high = price;
        if (price < low) low = price;
        volume += size;
        totalValue += price * size;
    });
    const open = parseFloat(trades[0].price);
    const close = parseFloat(trades[trades.length - 1].price);
    const avgPrice = volume > 0 ? totalValue / volume : close;
    const priceChange = open > 0 ? ((close - open) / open) * 100 : 0;
    return {
        symbol,
        last: close.toFixed(8),
        high: high.toFixed(8),
        low: low.toFixed(8),
        open: open.toFixed(8),
        close: close.toFixed(8),
        volume: volume.toFixed(8),
        avg_price: avgPrice.toFixed(8),
        price_change: priceChange.toFixed(2) + '%',
        timestamp: new Date().toISOString()
    };
}
/**
 * Получение улучшенных mock-данных
 */
async function getEnhancedMockTickers() {
    const result = {};
    // Базовые пары
    Object.keys(MOCK_TICKERS).forEach(symbol => {
        result[symbol] = addRandomFluctuation(MOCK_TICKERS[symbol]);
    });
    // Добавляем динамически пары из базы данных
    await addDynamicPairs(result);
    return result;
}
/**
 * Добавление динамических пар из базы
 */
async function addDynamicPairs(result) {
    try {
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
            where: { active: true, is_public: true },
            raw: true,
            nest: true
        });
        pairs.forEach(pair => {
            const symbol = (pair.name || `${pair.base_coin.symbol}-${pair.quote_coin.symbol}`).replace('/', '-').toLowerCase();
            // Если пары еще нет в результатах
            if (!result[symbol] && !MOCK_TICKERS[symbol]) {
                result[symbol] = generateRealisticMockTicker(symbol, pair);
            }
        });
    } catch (error) {
        console.error('Error adding dynamic pairs:', error.message);
    }
    return result;
}
/**
 * Генерация реалистичного mock-тикера для пары
 */
function generateRealisticMockTicker(symbol, pair) {
    const normalizedSymbol = String(symbol || '').toLowerCase().replace(/\//g, '-');
    const parts = normalizedSymbol.split('-');
    const base = parts[0];
    const quote = parts[1] || 'usdt';
    // Базовые цены для популярных криптовалют
	const basePrices = {
		'btc': 95000,
		'eth': 3200,
		'lbtc': 0.0001,
		'sol': 175,
		'trx': 0.27,
		'gor': 0.001,
		'kas': 0.10,
		'xht': 0.55,
		'usdt': 1,
		'usd': 1,
		'eur': 0.92,
		'rub': 90
	};
    const basePrice = basePrices[base.toLowerCase()] || 10;
    const quotePrice = basePrices[quote.toLowerCase()] || 1;
    // Рассчитываем цену в quote валюте
    const price = basePrice / quotePrice;
    // Добавляем случайные колебания
    const fluctuation = (Math.random() * 0.1) - 0.05; // ±5%
    const currentPrice = price * (1 + fluctuation);
    const openPrice = price * (1 + (Math.random() * 0.05) - 0.025);
    const high = currentPrice * (1 + Math.random() * 0.03);
    const low = currentPrice * (1 - Math.random() * 0.03);
    const volume = (1000 + Math.random() * 10000) * price;
    const priceChange = ((currentPrice - openPrice) / openPrice * 100);
    return {
        symbol: normalizedSymbol,
        last: currentPrice.toFixed(8),
        high: high.toFixed(8),
        low: low.toFixed(8),
        open: openPrice.toFixed(8),
        close: currentPrice.toFixed(8),
        volume: volume.toFixed(2),
        avg_price: ((high + low) / 2).toFixed(8),
        price_change: priceChange.toFixed(2) + '%',
        timestamp: new Date().toISOString()
    };
}
/**
 * Получение mock-тикера для конкретной пары
 */
function getMockTickerForPair(symbol) {
    if (MOCK_TICKERS[symbol]) {
        return addRandomFluctuation(MOCK_TICKERS[symbol]);
    }
    // Генерация для новой пары
    return generateRealisticMockTicker(symbol);
}

module.exports = { getTickersUtils };
