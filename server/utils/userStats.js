// utils/userStats.js
'use strict';

const { Trade, Order, Balance } = require('../db/models');
const Sequelize = require('sequelize');
const { Op } = Sequelize;

const getUserStatsUtils = async (params) => {
    const { user_id } = params.query;

    if (!user_id) {
        throw new Error('user_id is required');
    }

    try {
        const [
            totalTrades,
            openOrders,
            balances
        ] = await Promise.all([
            Trade.count({
                where: {
                    [Op.or]: [
                        { maker_id: user_id },
                        { taker_id: user_id }
                    ]
                }
            }),
            Order.count({
                where: {
                    user_id,
                    status: {
                        [Op.in]: ['new', 'partially_filled']
                    }
                }
            }),
            Balance.findAll({
                where: { user_id }
            })
        ]);

        const totalBalance = balances.reduce((acc, b) => acc + Number(b.balance || 0), 0);

        return {
            user_id,
            total_trades: totalTrades,
            open_orders: openOrders,
            assets_count: balances.length,
            total_balance: totalBalance
        };
    } catch (error) {
        console.error('GET user stats error:', error);
        throw new Error('Failed to fetch user stats');
    }
};

module.exports = {
    getUserStatsUtils
};
