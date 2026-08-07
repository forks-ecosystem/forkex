'use strict';

const { Balance, Coin } = require('../db/models');
const getUserBalanceUtils = async (params) => {
  const { user_id } = params.query;
  if (!user_id) { throw new Error('user_id is required'); }
  try {
    const balances = await Balance.findAll({
      where: { user_id },
      include: [{
        model: Coin,
        as: 'coin',
        attributes: ['is_public', 'active'],
        required: true
      }],
      order: [['currency', 'ASC']]
    });
    const data = balances
      .filter(b => b.coin && b.coin.is_public && b.coin.active)
      .map(b => {
        const balance = Number(b.balance);
        const available = Number(b.available);
        return {
          currency: b.currency,
          balance,
          available,
          pending: Number((balance - available).toFixed(8))
        };
      });
    const flat = {};
    data.forEach(({ currency, balance, available, pending }) => {
      flat[`${currency}_balance`] = balance;
      flat[`${currency}_available`] = available;
      flat[`${currency}_pending`] = pending;
    });
    return { user_id, data, ...flat };
  } catch (error) {
    console.error('getUserBalanceUtils error:', error);
    throw new Error('Failed to fetch user balance');
  }
};
module.exports = { getUserBalanceUtils };
