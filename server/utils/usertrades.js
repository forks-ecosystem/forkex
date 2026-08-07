'use strict';

const { Trade, Pair } = require('../db/models');
const { Op } = require('sequelize');
const { loggerWebsocket } = require('../config/logger');

const getUserTradesUtils = async (params) => {
  const {
    user_id,
    symbol,
    limit = 50,
    page = 1,
    order_by = 'timestamp',
    order = 'desc'
  } = params.query;

  if (!user_id) {
    throw new Error('user_id is required');
  }

  const where = {
    [Op.or]: [
      { maker_id: user_id },
      { taker_id: user_id }
    ]
  };

  const allowedOrderBy = ['id', 'timestamp', 'price', 'size'];
  const orderBy = allowedOrderBy.includes(order_by) ? order_by : 'timestamp';
  const orderDir = order === 'asc' ? 'ASC' : 'DESC';

  try {
    const trades = await Trade.findAll({
      where,
      include: [{
        model: Pair,
        as: 'Pair',
        attributes: ['name'],
        where: symbol ? { name: symbol } : undefined
      }],
      order: [[orderBy, orderDir]],
      limit: Number(limit),
      offset: (Number(page) - 1) * Number(limit)
    });

    const data = trades.map(t => {
      const isMaker = t.maker_id === Number(user_id);
      return {
        id: t.id,
        symbol: t.Pair.name,
        price: Number(t.price),
        size: Number(t.size),
        side: t.side,
        timestamp: t.timestamp,
        created_by: isMaker ? t.maker_id : t.taker_id,
        order_id: isMaker ? t.maker_order_id : t.taker_order_id,
        fee: isMaker
          ? Number(t.maker_fee || 0)
          : Number(t.taker_fee || 0)
      };
    });

    return { count: data.length, data };
  } catch (err) {
    loggerWebsocket.error('GET /user/trades error', err);
    throw new Error('2.Failed to fetch trades');
  }
};

module.exports = {
  getUserTradesUtils
};
