'use strict';

const models = require('../models');

module.exports = {
	up: async () => {
		const Coin = models['Coin'];
		const Pair = models['Pair'];

		await Pair.destroy({ where: {} });

		const getCoinId = async (symbol) => {
			const coin = await Coin.findOne({ where: { symbol } });
			return coin ? coin.id : null;
		};

		const btcId = await getCoinId('btc');
		const ethId = await getCoinId('eth');
		const solId = await getCoinId('sol');
		const trxId = await getCoinId('trx');
		const usdtId = await getCoinId('usdt');
		const xhtId = await getCoinId('xht');
		const gorId = await getCoinId('gor');
		const kasId = await getCoinId('kas');

		const pairs = [
			{ base_coin_id: btcId, pair_base: 'btc', quote_coin_id: usdtId, pair_2: 'usdt', symbol: 'btc-usdt', name: 'BTC/USDT', active: true, taker_fees: 0.001, maker_fees: 0.0005, min_size: 0.0001, max_size: 100, increment_size: 0.0001, increment_price: 0.01 },
			{ base_coin_id: ethId, pair_base: 'eth', quote_coin_id: usdtId, pair_2: 'usdt', symbol: 'eth-usdt', name: 'ETH/USDT', active: true, taker_fees: 0.001, maker_fees: 0.0005, min_size: 0.001, max_size: 1000, increment_size: 0.001, increment_price: 0.01 },
			{ base_coin_id: solId, pair_base: 'sol', quote_coin_id: usdtId, pair_2: 'usdt', symbol: 'sol-usdt', name: 'SOL/USDT', active: true, taker_fees: 0.001, maker_fees: 0.0005, min_size: 0.01, max_size: 10000, increment_size: 0.01, increment_price: 0.01 },
			{ base_coin_id: trxId, pair_base: 'trx', quote_coin_id: usdtId, pair_2: 'usdt', symbol: 'trx-usdt', name: 'TRX/USDT', active: true, taker_fees: 0.001, maker_fees: 0.0005, min_size: 10, max_size: 1000000, increment_size: 1, increment_price: 0.0001 },
			{ base_coin_id: xhtId, pair_base: 'xht', quote_coin_id: usdtId, pair_2: 'usdt', symbol: 'xht-usdt', name: 'XHT/USDT', active: true, taker_fees: 0.001, maker_fees: 0.0005, min_size: 0.5, max_size: 100000, increment_size: 0.5, increment_price: 0.01 },
			{ base_coin_id: gorId, pair_base: 'gor', quote_coin_id: usdtId, pair_2: 'usdt', symbol: 'gor-usdt', name: 'GOR/USDT', active: true, taker_fees: 0.001, maker_fees: 0.0005, min_size: 0.01, max_size: 100000, increment_size: 0.01, increment_price: 0.01 },
			{ base_coin_id: kasId, pair_base: 'kas', quote_coin_id: usdtId, pair_2: 'usdt', symbol: 'kas-usdt', name: 'KAS/USDT', active: true, taker_fees: 0.001, maker_fees: 0.0005, min_size: 0.1, max_size: 1000000, increment_size: 0.1, increment_price: 0.01 },
		];

		for (const pair of pairs) {
			if (pair.base_coin_id && pair.quote_coin_id) {
				const exists = await Pair.findOne({ where: { symbol: pair.symbol } });
				if (!exists) {
					await Pair.create(pair);
				}
			}
		}
	},
	down: (queryInterface) => queryInterface.bulkDelete('pairs', null, {}),
};
