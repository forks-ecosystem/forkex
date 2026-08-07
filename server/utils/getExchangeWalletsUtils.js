'use strict';

const { UserAddressBook } = require('../db/models');
const Sequelize = require('sequelize');
const { Op } = Sequelize;

/**
 * Get list of wallets in the exchange (with JSONB filtering done in JS).
 * @param {object} req - Express-like request object with a `query` field.
 * @param {object} res - Express-like response object.
 * @returns {object} Object containing Count and Data (wallets array).
 */
const getExchangeWalletsUtils = async (req, res) => {
    try {
	const {
	    user_id,
	    currency,
	    network,
	    address,
	    is_valid,
	    limit = 50,
	    page = 1,
	    order_by = 'created_at',
	    order = 'desc',
	    start_date,
	    end_date
	} = req.query;

	const whereConditions = {};

	if (user_id) whereConditions.user_id = user_id;

	if (start_date || end_date) {
	    whereConditions.created_at = {};
	    if (start_date) whereConditions.created_at[Op.gte] = new Date(start_date);
	    if (end_date) whereConditions.created_at[Op.lte] = new Date(end_date);
	}

	// Получаем все записи с учетом базовых where-условий
	const wallets = await UserAddressBook.findAll({
	    where: whereConditions,
	    order: [[order_by, order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC']]
	});

	// Фильтрация по JSONB адресам вручную
	const flatData = wallets.flatMap(entry => {
	    if (!Array.isArray(entry.addresses)) return [];

	    return entry.addresses
		.filter(addr => {
		    if (currency && addr.currency !== currency) return false;
		    if (network && addr.network !== network) return false;
		    if (address && addr.address !== address) return false;
		    if (typeof is_valid === 'boolean' && addr.is_valid !== is_valid) return false;
		    return true;
		})
		.map(addr => ({
		    id: entry.id,
		    user_id: entry.user_id,
		    network_id: entry.network_id,
		    ...addr,
		    created_at: addr.created_at || entry.created_at,
		    updated_at: entry.updated_at
		}));
	});

	// Пагинация после фильтрации
	const offset = (parseInt(page) - 1) * parseInt(limit);
	const paginatedData = flatData.slice(offset, offset + parseInt(limit));

	return res.status(200).json({
	    count: flatData.length,
	    data: paginatedData
	});
    } catch (error) {
	console.error('Error fetching exchange wallets:', error);
	return res.status(500).json({ error: 'Failed to fetch exchange wallets' });
    }
};

module.exports = {
    getExchangeWalletsUtils
};
