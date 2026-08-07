// utils/brokerTrade.js
'use strict';

const { Trade, Order, Balance } = require('../db/models');
const { sequelize } = require('../db/models');

const createBrokerTradeUtils = async (req) => {
    const {
        symbol,
        side,
        price,
        size,
        maker_id,
        taker_id,
        fee_structure
    } = req.body;

    return sequelize.transaction(async (t) => {
        // 1 создать trade
        const trade = await Trade.create({
            symbol,
            side,
            price,
            size,
            maker_id,
            taker_id,
            maker_fee: fee_structure.maker,
            taker_fee: fee_structure.taker
        }, { transaction: t });

        // 2 обновить балансы
        // 3 обновить ордера
        // 4 emit WS events (trade/order/balance)

        return {
            id: trade.id,
            symbol,
            price,
            size,
            maker_id,
            taker_id
        };
    });
};

module.exports = { createBrokerTradeUtils };
