// server/utils/price.js
'use strict';

const { Trade, Order, Pair } = require('../db/models');
const { Op } = require('sequelize');

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

    // 2 fallback mid price из открытых ордеров
    const pair = await Pair.findOne({ where: { symbol } });
    if (pair) {
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

        if (bestBid > 0 && bestAsk < Infinity) {
            return {
                symbol,
                price: (bestBid + bestAsk) / 2,
                source: 'orderbook',
                timestamp: new Date()
            };
        }
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
