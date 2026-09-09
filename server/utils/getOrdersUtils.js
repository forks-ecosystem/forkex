'use strict';

const { Order, Pair, User } = require('../db/models');

const resolveUserId = async (userId) => {
  if (!userId) return userId;
  const numId = Number(userId);
  if (isNaN(numId)) return userId;
  const user = await User.findOne({ where: { id: numId }, attributes: ['id', 'network_id'], raw: true });
  if (!user) return userId;
  return user.network_id != null ? user.network_id : userId;
};

const getOrdersUtils = async (params) => {
  const {
    user_id,
    open,
    order_by = 'created_at',
    order = 'desc',
    limit = 50,
    page = 1
  } = params.query;

  const where = {};
  if (user_id) where.user_id = await resolveUserId(user_id);
  if (open === 'true') where.status = 'open';

  try {
    const orders = await Order.findAll({
      where,
      include: [{
        model: Pair,
        as: 'Pair',
        attributes: ['name']
      }],
      order: [[order_by, order.toUpperCase()]],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    return {
      data: orders.map(o => ({
        id: String(o.id),
        order_id: o.order_id,
        user_id: o.user_id,
        created_by: o.user_id,
        network_id: o.user_id,
        pair: o.symbol || o.Pair?.symbol,
        symbol: o.symbol,
        side: o.side,
        price: Number(o.price),
        size: Number(o.size),
        filled: o.accepted_amount,
        status: o.status,
        created_at: o.created_at,
        updated_at: o.updated_at
      }))
    };
  } catch (err) {
    console.error('GET /orders error', err);
    throw new Error('Failed to fetch orders');
  }
};

module.exports = {
  getOrdersUtils
};
