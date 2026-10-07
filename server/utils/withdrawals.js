'use strict';

const { Withdrawal, Coin } = require('../db/models'); // Используем Coin, а не Pair
const { Op } = require('sequelize');
const {
	formatWithdrawal,
	readStatusFlags,
	statusStringsMatching
} = require('./withdrawalStatus');

// Выборка истории выводов пользователя. Форма строки и разбор фильтра статуса
// живут в ./withdrawalStatus — там же они и тестируются без БД.
const getWithdrawalsUtils = async (params) => {
	const {
		user_id,
		limit = 50,
		page = 1,
		start_date,
		end_date,
		currency
	} = params.query;

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

		// Фильтр из DepositAndWithdrawlFilters. Раньше currency приходил от UI, но
		// игнорировался, и выбор валюты показывал выводы всех монет.
		if (currency && currency !== 'all') {
			const coinIds = (
				await Coin.findAll({
					where: { symbol: String(currency).toLowerCase() },
					attributes: ['id']
				})
			).map((c) => c.id);
			if (!coinIds.length) {
				return { count: 0, data: [] };
			}
			whereConditions.coin_id = coinIds;
		}

		const flags = readStatusFlags(params.query);
		if (Object.keys(flags).length) {
			const allowed = statusStringsMatching(flags);
			if (!allowed.length) {
				return { count: 0, data: [] };
			}
			whereConditions.status = allowed.length === 1 ? allowed[0] : { [Op.in]: allowed };
		}

		// findAndCountAll, а не findAll: `count` в ответе — это общее число строк
		// для пагинации. Раньше туда клалась длина текущей страницы, из-за чего
		// вторая и последующие страницы считались пустыми при limit < выборки.
		const { count, rows } = await Withdrawal.findAndCountAll({
			where: whereConditions,
			order: [['created_at', 'DESC']],
			limit: parseInt(limit),
			offset: (parseInt(page) - 1) * parseInt(limit),
			include: [
				{
					model: Coin,
					as: 'coin',
					attributes: ['symbol', 'name']
				}
			]
		});

		return { count, data: rows.map(formatWithdrawal) };

	} catch (error) {
		console.error('Error fetching withdrawals:', error);
		throw new Error('Failed to fetch withdrawals');
	}
};

module.exports = {
	getWithdrawalsUtils
};
