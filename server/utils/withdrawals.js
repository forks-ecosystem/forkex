'use strict';

const { Withdrawal, Coin } = require('../db/models'); // Используем Coin, а не Pair
const { Op } = require('sequelize');

const getWithdrawalsUtils = async (params) => {
  const { user_id, limit = 50, page = 1, start_date, end_date } = params.query;

  if (!user_id) {
    throw new Error('user_id is required');
  }

  try {
    const whereConditions = { user_id };

    // Диапазон дат
    if (start_date || end_date) {
      whereConditions.created_at = {};
      if (start_date) {
        whereConditions.created_at[Op.gte] = new Date(start_date);
      }
      if (end_date) {
        whereConditions.created_at[Op.lte] = new Date(end_date);
      }
    }

    const withdrawals = await Withdrawal.findAll({
      where: whereConditions,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
      include: [
        {
          model: Coin,
          as: 'coin',
          attributes: ['symbol']
        }
      ]
    });

    const formatted = withdrawals.map(w => ({
      id: w.id,
      user_id: w.user_id,
      coin_id: w.coin_id,
      amount: parseFloat(w.amount),
      status: w.status === 'completed',
      created_at: w.created_at,
      updated_at: w.updated_at,
      currency: w.coin?.symbol || '-',
      network_id: w.network_id || 1
    }));

    return { count: formatted.length, data: formatted };

  } catch (error) {
    console.error('Error fetching withdrawals:', error);
    throw new Error('Failed to fetch withdrawals');
  }
};

module.exports = {
  getWithdrawalsUtils
};
