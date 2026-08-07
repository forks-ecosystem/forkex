'use strict';

const { Order, Pair } = require('../db/models');
const Sequelize = require('sequelize');
const { Op } = Sequelize;

const getOrderbookUtils = async (params) => {
    const {
        symbol,
        limit = 50
    } = params.query;

    if (!symbol) {
        throw new Error('symbol is required');
    }

    const pair = await Pair.findOne({ where: { [Op.or]: [{ symbol }, { name: symbol }], is_public: true } });
    if (!pair) {
        throw new Error(`Unknown symbol: ${symbol}`);
    }

    const rows = await Order.findAll({
        where: { pair_id: pair.id, status: 'open' },
        attributes: ['side', 'price', 'size'],
        raw: true
    });

    const bidMap = {};
    const askMap = {};

    for (const r of rows) {
        const price = Number(r.price);
        const size = Number(r.size);
        if (r.side === 'buy' && size > 0) {
            bidMap[price] = (bidMap[price] || 0) + size;
        } else if (r.side === 'sell' && size > 0) {
            askMap[price] = (askMap[price] || 0) + size;
        }
    }

    const bids = Object.entries(bidMap)
        .map(([p, q]) => [Number(p), Number(q)])
        .sort((a, b) => b[0] - a[0])
        .slice(0, limit);

    const asks = Object.entries(askMap)
        .map(([p, q]) => [Number(p), Number(q)])
        .sort((a, b) => a[0] - b[0])
        .slice(0, limit);

    return {
        symbol,
        bids,
        asks,
        timestamp: Date.now()
    };
};

const { getOrderbooksUtils } = require('./orderbooks');

module.exports = {
    getOrderbookUtils,
    getOrderbooksUtils
};
