'use strict';

const toolsLib = require('hollaex-tools-lib');
const { Pair } = require('../db/models');

const getTickersUtils = async (headers = {}) => {
  try {
    const pairs = await Pair.findAll();
    const symbols = pairs.map(p => p.symbol);

    const tickers = {};

    await Promise.all(
      symbols.map(symbol =>
        toolsLib.getTicker(symbol, {
          additionalHeaders: headers
        }).then(data => {
          tickers[symbol] = data;
        }).catch(err => {
          tickers[symbol] = { error: err.message };
        })
      )
    );

    return { success: true, tickers };
  } catch (error) {
    console.error('getTickersUtils error:', error);
    throw new Error('Failed to fetch tickers');
  }
};

module.exports = {
  getTickersUtils
};
