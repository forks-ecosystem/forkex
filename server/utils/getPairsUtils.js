'use strict';

const express = require('express');
const router = express.Router();
const { Pair, Coin } = require('../db/models');

router.get('/', async (req, res) => {
  try {
    const pairs = await Pair.findAll({
      where: {
        active: true,
        is_public: true
      },
      include: [
        {
          model: Coin,
          as: 'base_coin',
          attributes: ['symbol']
        },
        {
          model: Coin,
          as: 'quote_coin',
          attributes: ['symbol']
        }
      ],
      order: [['id', 'ASC']]
    });

    const result = pairs.map(p => ({
      id: p.id,
      name: p.name,                 // btc-usdt
      symbol: p.name,
      base: p.base_coin.symbol,
      quote: p.quote_coin.symbol,
      active: true,
      increment_price: p.increment_price,
      increment_size: p.increment_size,
      min_size: p.min_size,
      max_size: p.max_size,
      maker_fee: p.maker_fees,
      taker_fee: p.taker_fees
    }));

    res.json(result);
  } catch (e) {
    console.error('GET /v2/pairs error:', e);
    res.status(500).json({ error: 'failed_to_get_pairs' });
  }
});

module.exports = router;

