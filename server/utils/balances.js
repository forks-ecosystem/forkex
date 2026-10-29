'use strict';

const { Balance, Coin } = require('../db/models');
const { Op } = require('sequelize');

const getBalancesUtils = async (params) => {
  const { user_id, currency, format, limit = 50, page = 1 } = params.query;
  try {
    const where = {};
    if (user_id) where.user_id = user_id;
    if (currency) where.currency = currency;

    const include = [{
      model: Coin,
      as: 'coin',
      attributes: ['symbol', 'is_public', 'active'],
      where: { is_public: true, active: true },
      required: true
    }];

    // format=all is used by admin bulk listings (balances history job, csv export),
    // it must not be cut off by pagination
    const isAll = format === 'all';

    const balances = await Balance.findAll({
      where,
      order: [['updated_at', 'DESC']],
      ...(isAll ? {} : {
        limit: parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit)
      }),
      include
    });
    const formatted = balances.map(d => ({
      id: d.id,
      user_id: d.user_id,
      symbol: d.coin?.symbol || d.currency,
      currency: d.currency,
      balance: parseFloat(d.balance),
      available: parseFloat(d.available),
      updated_at: d.updated_at,
      coin_symbol: d.coin?.symbol || null
    }));
    const count = await Balance.count({ where, include });
    return { data: formatted, count };
  } catch (error) {
    console.error('GET /api/v2/balances error:', error);
    throw new Error('Failed to fetch balances');
  }
};
module.exports = {
  getBalancesUtils
};
