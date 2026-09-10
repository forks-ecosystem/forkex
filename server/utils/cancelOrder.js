// utils/cancelOrder.js
'use strict';

const { Op } = require('sequelize');
const { Order } = require('../db/models');

const cancelOrderUtils = async (params) => {
    const { user_id, order_id } = params.query;

    if (!user_id || !order_id) {
        throw new Error('user_id and order_id are required');
    }

    const whereOr = [];
    if (/^\d+$/.test(order_id)) {
        whereOr.push({ id: Number(order_id) });
    } else {
        whereOr.push({ order_id });
    }

    const order = await Order.findOne({
        where: {
            user_id,
            [Op.or]: whereOr
        }
    });

    if (!order) {
        throw new Error('Order not found');
    }

    if (['filled', 'canceled'].includes(order.status)) {
        throw new Error(`Order already ${order.status}`);
    }

    order.status = 'canceled';
    await order.save();

    return {
        id: order.order_id || String(order.id),
        order_id: order.order_id,
        symbol: order.symbol,
        side: order.side,
        price: Number(order.price),
        size: Number(order.size),
        status: order.status,
        canceled_at: new Date().toISOString()
    };
};

module.exports = { cancelOrderUtils };
