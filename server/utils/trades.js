'use strict';

const { Trade, Pair } = require('../db/models');

const getTradesUtils = async (params) => {
  const {
    user_id,
    symbol,
    limit = 50,
    page = 1,
    order_by = 'created_at',
    order = 'desc'
  } = params.query;

  if (!user_id) {
    throw new Error('user_id is required');
  }

  const where = { user_id };

  try {
    const trades = await Trade.findAll({
      where,
      include: [{
        model: Pair,
        as: 'Pair',
        attributes: ['name']
      }],
      order: [[order_by, order.toUpperCase()]],
      limit: Number(limit),
      offset: (Number(page) - 1) * Number(limit)
    });

    const data = trades
      .filter(t => !symbol || t.Pair.name === symbol)
      .map(t => ({
        id: t.id,
        symbol: t.Pair.name,        // 🔴 ОБЯЗАТЕЛЬНО
        price: Number(t.price),
        size: Number(t.size),
        side: t.side,
        created_at: t.created_at,
        created_by: t.user_id,      // 🔴 network user id
        order_id: t.order_id || null,
        fee: t.fee ? Number(t.fee) : 0
      }));

    return {
      count: data.length,
      data
    };
  } catch (err) {
    console.error('GET /user/trades error', err);
    throw new Error('1.Failed to fetch trades');
  }
};

module.exports = {
  getTradesUtils
};
