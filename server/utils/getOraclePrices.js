const { Trade, Coin } = require('../db/models');
const { loggerWebsocket } = require('../config/logger');
const { sequelize } = require('../db/models');

async function getOraclePricesUtils(req, res) {
    let { assets, quote = 'usdt', amount = 1 } = req.query;
    if (!assets) {
        return res.status(400).json({ message: 'assets is required' });
    }
    if (typeof assets === 'string') {
        assets = assets.split(',');
    }
    quote = typeof quote === 'string' && quote !== 'undefined'
        ? quote.toLowerCase()
        : 'usdt';
    amount = Number(amount) > 0 ? Number(amount) : 1;
    const result = {};
    for (const assetRaw of assets) {
        const asset = assetRaw.toLowerCase();
        const symbol = `${asset}-${quote}`;
        // 1️⃣ пробуем последнюю сделку
        const trade = await Trade.findOne({
            where: { symbol },
            order: [['created_at', 'DESC']],
            attributes: ['price']
        });
        if (trade && trade.price != null) {
            result[asset] = Number(trade.price) * amount;
            continue;
        }
        // 2️⃣ fallback на Coins.estimated_price
        const coin = await Coin.findOne({
            where: { symbol: asset },
            attributes: ['estimated_price']
        });
        if (coin && coin.estimated_price != null) {
            result[asset] = Number(coin.estimated_price) * amount;
            continue;
        }
        // 3️⃣ fallback на market_prices
        try {
            const [rows] = await sequelize.query(
                'SELECT price FROM market_prices WHERE symbol = :asset LIMIT 1',
                { replacements: { asset } }
            );
            if (rows && rows.length > 0 && rows[0].price != null) {
                result[asset] = Number(rows[0].price) * amount;
                continue;
            }
        } catch (e) {
            loggerWebsocket.error(`oracle/prices market_prices query error: ${e.message}`);
        }
        // 4️⃣ fallback на quote asset с тем же именем (usdt -> usdt price = 1)
        if (asset === quote) {
            result[asset] = 1 * amount;
            continue;
        }
        // 5️⃣ если цены нет нигде → ошибка данных
        loggerWebsocket.error(
            `oracle/prices missing price for asset=${asset}`
        );
        return res.status(400).json({
            message: `Price not available for asset: ${asset}`
        });
    }
    return res.json(result);
}
module.exports = {
    getOraclePricesUtils
};
