// server/api/services/coins.js

const { Coin } = require('../../db/models'); // путь смотри по проекту
const { loggerAdmin } = require('../../config/logger');
const getCoinsFromDB = async () => {
    const coins = await Coin.findAll({
        where: {
            is_public: true,
            active: true
        },
        order: [['id', 'ASC']]
    });
    //loggerAdmin.error('===coins',coins);
    // приводим к формату UI
    return coins.reduce((acc, coin) => {
        acc[coin.symbol] = {
            id: coin.id,
            symbol: coin.symbol,
            code: coin.code,
            fullname: coin.fullname,
            display_name: coin.display_name,
            icon: coin.icon_url,
            icon_url: coin.icon_url,
            withdrawal_fee: coin.withdrawal_fee,
            min: coin.min,
            max: coin.max,
            increment: coin.increment,
            increment_unit: coin.increment_unit,
            estimated_price: coin.estimated_price,
            allow_deposit: coin.allow_deposit,
            allow_withdrawal: coin.allow_withdrawal,
            network: coin.network,
            meta: coin.meta,
            type: coin.type,
            is_risky: coin.is_risky,
            withdrawal_fees: coin.withdrawal_fees
        };
        return acc;
    }, {});
};

module.exports = {
    getCoinsFromDB
};
