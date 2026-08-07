'use strict';

const models = require('../models');

module.exports = {
	up: async () => {
		const UserAddressBook = models['UserAddressBook'];
		const now = new Date().toISOString();
		const entries = [
			{
				user_id: 58,
				addresses: [
					{
						network: 'btc',
						address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
						label: 'BTC main wallet',
						currency: 'btc',
						created_at: now
					},
					{
						network: 'eth',
						address: '0x32Be343B94f860124dC4fEe278FDCBD38C102D88',
						label: 'ETH main wallet',
						currency: 'eth',
						created_at: now
					}
				]
			},
			{
				user_id: 57,
				addresses: [
					{
						network: 'btc',
						address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
						label: 'BTC savings',
						currency: 'btc',
						created_at: now
					},
					{
						network: 'usdt',
						address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
						label: 'USDT TRC20',
						currency: 'usdt',
						created_at: now
					}
				]
			},
			{
				user_id: 9,
				addresses: [
					{
						network: 'eth',
						address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
						label: 'ETH test',
						currency: 'eth',
						created_at: now
					}
				]
			}
		];

		for (const entry of entries) {
			const existing = await UserAddressBook.findOne({ where: { user_id: entry.user_id } });
			if (!existing) {
				await UserAddressBook.create(entry);
			}
		}
	},
	down: (queryInterface) => queryInterface.bulkDelete('user_address_books', {
		user_id: [58, 57, 9]
	})
};
