'use strict';

const models = require('../models');

module.exports = {
	up: async () => {
		const Balance = models['Balance'];

		await Balance.destroy({ where: {} });

		const balances = [
			{ user_id: 58, currency: 'btc', balance: 0.5, available: 0.5, locked: 0 },
			{ user_id: 58, currency: 'eth', balance: 5.0, available: 5.0, locked: 0 },
			{ user_id: 58, currency: 'usdt', balance: 10000, available: 10000, locked: 0 },
			{ user_id: 58, currency: 'sol', balance: 50, available: 50, locked: 0 },
			{ user_id: 58, currency: 'trx', balance: 5000, available: 5000, locked: 0 },
			{ user_id: 58, currency: 'xht', balance: 100, available: 100, locked: 0 },
			{ user_id: 58, currency: 'gor', balance: 200, available: 200, locked: 0 },
			{ user_id: 58, currency: 'kas', balance: 1000, available: 1000, locked: 0 },

			{ user_id: 57, currency: 'btc', balance: 0.2, available: 0.2, locked: 0 },
			{ user_id: 57, currency: 'eth', balance: 2.0, available: 2.0, locked: 0 },
			{ user_id: 57, currency: 'usdt', balance: 5000, available: 5000, locked: 0 },
			{ user_id: 57, currency: 'sol', balance: 20, available: 20, locked: 0 },
			{ user_id: 57, currency: 'trx', balance: 3000, available: 3000, locked: 0 },
			{ user_id: 57, currency: 'xht', balance: 50, available: 50, locked: 0 },
			{ user_id: 57, currency: 'gor', balance: 100, available: 100, locked: 0 },
			{ user_id: 57, currency: 'kas', balance: 500, available: 500, locked: 0 },

			{ user_id: 9, currency: 'btc', balance: 0.1, available: 0.1, locked: 0 },
			{ user_id: 9, currency: 'eth', balance: 1.0, available: 1.0, locked: 0 },
			{ user_id: 9, currency: 'usdt', balance: 2000, available: 2000, locked: 0 },
			{ user_id: 9, currency: 'sol', balance: 10, available: 10, locked: 0 },
			{ user_id: 9, currency: 'trx', balance: 1000, available: 1000, locked: 0 },
			{ user_id: 9, currency: 'xht', balance: 25, available: 25, locked: 0 },
			{ user_id: 9, currency: 'gor', balance: 50, available: 50, locked: 0 },
			{ user_id: 9, currency: 'kas', balance: 200, available: 200, locked: 0 },
		];

		for (const balance of balances) {
			const exists = await Balance.findOne({
				where: { user_id: balance.user_id, currency: balance.currency },
			});
			if (!exists) {
				await Balance.create(balance);
			}
		}
	},
	down: (queryInterface) => queryInterface.bulkDelete('balances', null, {}),
};
