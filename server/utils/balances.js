'use strict';

const { Balance, Coin } = require('../db/models');
const { Op } = require('sequelize');

const getBalancesUtils = async (params) => {
  const { user_id, limit = 50, page = 1 } = params.query;
  if (!user_id) { throw new Error('user_id is required'); }
  try {
    const balances = await Balance.findAll({
      where: { user_id },
      order: [['updated_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
      include: [{
        model: Coin,
        as: 'coin',
        attributes: ['symbol', 'is_public', 'active'],
        where: { is_public: true, active: true },
        required: true
      }]
    });
    const formatted = balances.map(d => ({
      id: d.id,
      user_id: d.user_id,
      currency: d.currency,
      balance: parseFloat(d.balance),
      available: parseFloat(d.available),
      updated_at: d.updated_at,
      coin_symbol: d.coin?.symbol || null
    }));
    return { data: formatted };
  } catch (error) {
    console.error('GET /api/v2/balances error:', error);
    throw new Error('Failed to fetch balances');
  }
};
module.exports = {
  getBalancesUtils
};
