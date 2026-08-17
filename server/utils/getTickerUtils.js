// server/utils/getTickerUtils.js
'use strict';

const { Trade, Order, Pair } = require('../db/models');
const { Op } = require('sequelize');

/**
 * Get ticker info for a symbol
 * @param {string} symbol - Symbol to fetch ticker for
 * @returns {object} ticker data
 */
async function getTickerUtils(symbol) {
    if (!symbol) {
        // Если symbol не указан, возвращаем все тикеры
        return await getAllTickers();
    }

    try {
        // Находим pair_id по symbol
        const pair = await Pair.findOne({
            where: { name: symbol, is_public: true }
        });
        
        if (!pair) {
            throw new Error(`Unknown symbol: ${symbol}`);
        }

        // Последний трейд
        const lastTrade = await Trade.findOne({
            where: { symbol },
            order: [['timestamp', 'DESC']],
            raw: true
        });

        // Бест бид/аск из открытых ордеров
        const openOrders = await Order.findAll({
            where: { pair_id: pair.id, status: 'open' },
            attributes: ['side', 'price'],
            raw: true
        });

        let bestBid = 0;
        let bestAsk = Infinity;
        for (const o of openOrders) {
            const p = parseFloat(o.price);
            if (o.side === 'buy' && p > bestBid) bestBid = p;
            if (o.side === 'sell' && p < bestAsk) bestAsk = p;
        }

        // 24ч объем
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const trades24h = await Trade.findAll({
            where: {
                symbol,
                timestamp: { [Op.gte]: yesterday }
            },
            raw: true
        });

        let volume24h = 0;
        let high24h = 0;
        let low24h = Infinity;
        let openPrice = 0;
        
        if (trades24h.length > 0) {
            const sortedTrades = [...trades24h].sort((a, b) => 
                new Date(a.timestamp) - new Date(b.timestamp)
            );
            
            openPrice = parseFloat(sortedTrades[0].price) || 0;
            
            trades24h.forEach(trade => {
                const price = parseFloat(trade.price) || 0;
                const size = parseFloat(trade.size) || 0;
                
                volume24h += size;
                high24h = Math.max(high24h, price);
                low24h = Math.min(low24h, price === 0 ? Infinity : price);
            });
        }

        if (low24h === Infinity) low24h = 0;

        const lastPrice = lastTrade ? parseFloat(lastTrade.price) : 0;
        const priceChange = openPrice > 0 ? ((lastPrice - openPrice) / openPrice) * 100 : 0;

        return {
            symbol,
            last: lastPrice.toFixed(8),
            bid: bestBid > 0 ? bestBid.toFixed(8) : '0',
            ask: bestAsk < Infinity ? bestAsk.toFixed(8) : '0',
            open: openPrice.toFixed(8),
            high: high24h.toFixed(8),
            low: low24h.toFixed(8),
            volume: volume24h.toFixed(8),
            price_change: priceChange.toFixed(2) + '%',
            timestamp: lastTrade ? new Date(lastTrade.timestamp).getTime() : Date.now()
        };
        
    } catch (err) {
        if (err.message && err.message.includes('Unknown symbol')) {
            throw err;
        }
        console.error('getTickerUtils error:', err);
        return createEmptyTicker(symbol);
    }
}

/**
 * Get all tickers
 */
async function getAllTickers() {
    try {
        const pairs = await Pair.findAll({
            where: { active: true, is_public: true },
            raw: true
        });

        const tickers = {};
        
        for (const pair of pairs) {
            try {
                const ticker = await getTickerUtils(pair.name);
                tickers[pair.name] = ticker;
            } catch (error) {
                console.error(`Error fetching ticker for ${pair.name}:`, error.message);
                tickers[pair.name] = createEmptyTicker(pair.name);
            }
        }
        
        return tickers;
        
    } catch (error) {
        console.error('getAllTickers error:', error);
        return {};
    }
}

/**
 * Create empty ticker
 */
function createEmptyTicker(symbol) {
    return {
        symbol,
        last: '0',
        bid: '0',
        ask: '0',
        open: '0',
        high: '0',
        low: '0',
        volume: '0',
        price_change: '0%',
        timestamp: Date.now()
    };
}

module.exports = {
    getTickerUtils,
    getAllTickers
};