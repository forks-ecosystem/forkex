// server/utils/price.js
'use strict';

const { Trade, Orderbook, Pair } = require('../db/models');

async function getPrice(symbol) {
    if (!symbol) throw new Error('symbol is required');

    // 1 последний трейд
    const lastTrade = await Trade.findOne({
        where: { symbol },
        order: [['timestamp', 'DESC']],
        attributes: ['price', 'timestamp']
    });

    if (lastTrade) {
        return {
            symbol,
            price: Number(lastTrade.price),
            source: 'trade',
            timestamp: lastTrade.timestamp
        };
    }

    // 2 fallback  mid price из orderbook
    const book = await Orderbook.findOne({
        include: [{
            model: Pair,
            where: { symbol }
        }],
        order: [['updated_at', 'DESC']]
    });

    if (book && book.bid_price && book.ask_price) {
        return {
            symbol,
            price: (Number(book.bid_price) + Number(book.ask_price)) / 2,
            source: 'orderbook',
            timestamp: book.updated_at
        };
    }

    // 3 безопасный fallback
    return {
        symbol,
        price: null,
        source: 'empty',
        timestamp: null
    };
}

module.exports = { getPrice };
