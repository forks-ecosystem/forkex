'use strict';

const { Order, Pair } = require('../db/models');
const Sequelize = require('sequelize');
const { Op } = Sequelize;

const getOrderbooksUtils = async () => {
    const pairs = await Pair.findAll({ where: { active: true, is_public: true }, raw: true });
    const result = {};

    for (const pair of pairs) {
        const rows = await Order.findAll({
            where: { pair_id: pair.id, status: 'open' },
            attributes: ['side', 'price', 'size'],
            raw: true
        });
        if (!rows.length) continue;

        let bestBid = null;
        let bestAsk = null;

        for (const r of rows) {
            const price = Number(r.price);
            if (r.side === 'buy' && price > 0 && (bestBid === null || price > bestBid)) bestBid = price;
            if (r.side === 'sell' && price > 0 && (bestAsk === null || price < bestAsk)) bestAsk = price;
        }

        result[pair.name] = {
            bid: bestBid,
            ask: bestAsk,
            spread: bestBid && bestAsk ? bestAsk - bestBid : null,
            volume: 0
        };
    }

    return result;
};

module.exports = {
    getOrderbooksUtils
};
