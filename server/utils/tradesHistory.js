'use strict';

const { Trade, Pair } = require('../db/models');
const { Op } = require('sequelize');

const getTradesHistoryUtils = async (params) => {
    const {
        symbol,
        side,
        limit = 50,
        page = 1,
        order_by = 'timestamp',
        order = 'desc',
        start_date,
        end_date
    } = params.query;

    const where = {};

    if (side) where.side = side;

    if (start_date || end_date) {
        where.timestamp = {};
        if (start_date) where.timestamp[Op.gte] = new Date(start_date);
        if (end_date) where.timestamp[Op.lte] = new Date(end_date);
    }

    try {
        const trades = await Trade.findAll({
            where,
            include: [{
                model: Pair,
                attributes: ['symbol'],
                ...(symbol ? { where: { symbol } } : {})
            }],
            order: [[order_by, order.toUpperCase()]],
            limit: Number(limit),
            offset: (Number(page) - 1) * Number(limit)
        });

        const data = trades.map(t => ({
            id: t.id,
            symbol: t.Pair?.symbol,
            side: t.side,
            price: Number(t.price),
            size: Number(t.size),
            timestamp: t.timestamp,
            maker_id: t.maker_id,
            taker_id: t.taker_id
        }));

        return {
            count: data.length,
            data
        };
    } catch (error) {
        console.error('GET /trades/history error:', error);
        throw new Error('Failed to fetch trades history');
    }
};

module.exports = {
    getTradesHistoryUtils
};
