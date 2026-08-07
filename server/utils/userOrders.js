// utils/userOrders.js
'use strict';

const { Order, Pair } = require('../db/models');
const { Op } = require('sequelize');
const { isBoolean } = require('lodash'); 
const getUserOrdersUtils = async (params) => {
    const {
        user_id,
        symbol,
        side,
        status,
        open,
        limit = 50,
        page = 1,
        order_by = 'created_at',
        order = 'desc',
        start_date,
        end_date
    } = params.query;

    if (!user_id) {
        throw new Error('user_id is required');
    }
    const where = { user_id };
    if (symbol) where.symbol = symbol;
    if (side) where.side = side;
    if (status) where.status = status;
    if (isBoolean(open)) {
        where.status = open ? { [Op.in]: ['new', 'open', 'partially_filled'] } : { [Op.notIn]: ['new', 'open', 'partially_filled'] };
    }
    if (start_date || end_date) {
        where.created_at = {};
        if (start_date) where.created_at[Op.gte] = new Date(start_date);
        if (end_date) where.created_at[Op.lte] = new Date(end_date);
    }
    const orders = await Order.findAll({
        where,
        order: [[order_by, order.toUpperCase()]],
        limit: Number(limit),
        offset: (Number(page) - 1) * Number(limit),
        include: [{
            model: Pair,
            as: 'Pair',
            attributes: ['symbol']
        }]
    });
    const data = orders.map(o => ({
        id: String(o.id),
        order_id: o.order_id,
        symbol: o.Pair?.symbol ?? o.symbol ?? '',
        side: o.side,
        price: Number(o.price),
        size: Number(o.size),
        filled: o.accepted_amount !== null ? Number(o.accepted_amount) : 0,
        status: o.status,
        created_at: o.created_at,
        updated_at: o.updated_at,
        created_by: o.user_id,
        network_id: o.user_id
    }));
    return {
        count: data.length,
        data
    };
};
module.exports = { getUserOrdersUtils };
