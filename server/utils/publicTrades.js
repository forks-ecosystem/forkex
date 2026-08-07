'use strict';

const { Trade, Pair } = require('../db/models');

const getPublicTradesUtils = async (params) => {
    const {
        symbol,
        limit = 50,
        page = 1
    } = params.query;

    try {
        const trades = await Trade.findAll({
            include: [{
                model: Pair,
                attributes: ['symbol'],
                where: { is_public: true, ...(symbol ? { symbol } : {}) }
            }],
            order: [['timestamp', 'DESC']],
            limit: Number(limit),
            offset: (Number(page) - 1) * Number(limit)
        });

        const data = trades.map(t => ({
            id: t.id,
            symbol: t.Pair?.symbol,
            side: t.side,
            price: Number(t.price),
            size: Number(t.size),
            timestamp: t.timestamp
        }));

        return {
            count: data.length,
            data
        };
    } catch (error) {
        console.error('GET /trades error:', error);
        throw new Error('Failed to fetch public trades');
    }
};

module.exports = {
    getPublicTradesUtils
};
