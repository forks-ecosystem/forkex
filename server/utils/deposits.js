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
        attributes: ['symbol', 'name'] // например, BTC, ETH и т.п.
      }]
    });
    // The deposit screen renders the address and the transaction id, so both have
    // to reach the client. `txid`/`transaction_id` are aliases: the user view and
    // the admin view read different key names for the same value.
    const formatted = deposits.map(d => ({
      id: d.id,
      user_id: d.user_id,
      coin_id: d.coin_id,
      amount: parseFloat(d.amount),
      status: d.status === 'completed' || d.status === '1' || d.status === true,
      address: d.address || '',
      tx_hash: d.tx_hash || '',
      txid: d.tx_hash || '',
      transaction_id: d.tx_hash || '',
      created_at: d.created_at,
      updated_at: d.updated_at,
      coin_name: d.coin?.name || '',
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
