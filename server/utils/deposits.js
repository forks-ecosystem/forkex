'use strict';

const { Deposit, Coin } = require('../db/models');

const getDepositsUtils = async (params) => {
  const { user_id, limit = 50, page = 1 } = params.query;
  if (!user_id) {
    throw new Error('user_id is required');
  }
  try {
    const deposits = await Deposit.findAll({
      where: { user_id },
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
      include: [{
        model: Coin,
        as: 'coin',
        attributes: ['symbol'] // например, BTC, ETH и т.п.
      }]
    });
    const formatted = deposits.map(d => ({
      id: d.id,
      user_id: d.user_id,
      coin_id: d.coin_id,
      amount: parseFloat(d.amount),
      status: d.status === 'completed' || d.status === '1' || d.status === true,
      created_at: d.created_at,
      updated_at: d.updated_at,
      currency: d.coin?.symbol?.toLowerCase() || '',
      symbol: d.coin?.symbol?.toLowerCase() || ''
    }));
    return { count: formatted.length, data: formatted };

  } catch (error) {
    console.error('GET /api/v2/deposits error:', error);
    throw new Error('Failed to fetch deposits');
  }
};
module.exports = {
    getDepositsUtils
};
