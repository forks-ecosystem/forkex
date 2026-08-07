const { execSync } = require('child_process');
const fs = require('fs');

// Load config from database
function loadConfig() {
    const tmpFile = `/tmp/mm-load-${process.pid}.sql`;
    fs.writeFileSync(tmpFile, `
        SELECT m.id as mm_id, m.name as mm_name, m.buyer_id, m.buyer_net, m.seller_id, m.seller_net,
               m.update_ms, m.trade_ms, m.active,
               s.name as strategy_name, s.pair, s.pair_id, s.mid_price, s.spread_pct,
               s.base_size, s.order_levels, s.prec, s.min_trade, s.max_trade,
               s.max_position, s.rebalance_threshold
        FROM market_makers m
        JOIN strategies s ON s.id = m.strategy_id
        WHERE m.active = true
        ORDER BY m.id
        LIMIT 1
    `);
    const cmd = `sudo docker exec -i forkex-db psql -U admin -d hollaex -t -A < ${tmpFile} 2>&1`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    fs.unlinkSync(tmpFile);
    const line = out.trim();
    if (!line) {
        console.error('[MM] No active market maker config found in DB');
        process.exit(1);
    }
    const c = line.split('|');
    return {
        MM_ID: parseInt(c[0]),
        USERS: {
            buyer:  { id: parseInt(c[2]), net: parseInt(c[3]) },
            seller: { id: parseInt(c[4]), net: parseInt(c[5]) },
        },
        UPDATE_MS: parseInt(c[6]),
        TRADE_MS: parseInt(c[7]),
        PAIR: c[10], PAIR_ID: parseInt(c[11]),
        MID_PRICE: parseFloat(c[12]),
        SPREAD_PCT: parseFloat(c[13]),
        BASE_SIZE: parseFloat(c[14]),
        ORDER_LEVELS: parseInt(c[15]),
        PREC: parseInt(c[16]),
        MIN_TRADE: parseFloat(c[17]),
        MAX_TRADE: parseFloat(c[18]),
        MAX_POSITION: parseFloat(c[19]),
        REBALANCE_THRESHOLD: parseFloat(c[20]),
    };
}

const CFG = loadConfig();
const PAIR = CFG.PAIR;
const PAIR_ID = CFG.PAIR_ID;
const USERS = CFG.USERS;
const MID_PRICE = CFG.MID_PRICE;
const SPREAD_PCT = CFG.SPREAD_PCT;
const BASE_SIZE = CFG.BASE_SIZE;
const ORDER_LEVELS = CFG.ORDER_LEVELS;
const PREC = CFG.PREC;
const UPDATE_MS = CFG.UPDATE_MS;
const TRADE_MS = CFG.TRADE_MS;
const MIN_TRADE = CFG.MIN_TRADE;
const MAX_TRADE = CFG.MAX_TRADE;
const MAX_POSITION = CFG.MAX_POSITION;
const REBALANCE_THRESHOLD = CFG.REBALANCE_THRESHOLD;

function psql(sql, opts = {}) {
    const flags = opts.tuplesOnly ? '-t -A' : '';
    const tmpFile = `/tmp/mm-sql-${process.pid}-${Date.now()}.sql`;
    fs.writeFileSync(tmpFile, sql);
    const cmd = `sudo docker exec -i forkex-db psql -U admin -d hollaex ${flags} < ${tmpFile} 2>&1`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    fs.unlinkSync(tmpFile);
    return out.trim();
}

function getOpenOrders() {
    const out = psql(`
        SELECT id, user_id, side, price, size FROM orders
        WHERE user_id IN (57,58) AND symbol = '${PAIR}' AND status = 'open'
        ORDER BY side, price
    `, { tuplesOnly: true });
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
        const c = line.split('|');
        return { id: parseInt(c[0]), userId: parseInt(c[1]), side: c[2], price: parseFloat(c[3]), size: parseFloat(c[4]) };
    });
}

function placeOrder(userId, side, price, size) {
    const oid = psql(`
        INSERT INTO orders (user_id, pair_id, side, price, size, status, symbol, created_at, updated_at)
        VALUES (${userId}, ${PAIR_ID}, '${side}', ${price}, ${size}, 'open', '${PAIR}', NOW(), NOW())
        RETURNING id
    `, { tuplesOnly: true });
    console.log(`[MM] user${userId} ${side} ${size} @ ${price} -> #${oid}`);
    return oid;
}

function cancelOrder(id) {
    psql(`UPDATE orders SET status='cancelled',updated_at=NOW() WHERE id=${id}`);
}

function runCycle() {
    const mid = MID_PRICE;
    const levels = ORDER_LEVELS;

    for (const user of [USERS.buyer, USERS.seller]) {
        const uid = user.id;
        const orders = getOpenOrders().filter(o => o.userId === uid);

        // Cancel orders outside price bounds
        for (const o of orders) {
            if (o.price < mid * 0.3 || o.price > mid * 3.0) {
                cancelOrder(o.id);
            }
        }

        // Count remaining good orders per side
        const good = { buy: [], sell: [] };
        for (const o of orders) {
            if (o.price >= mid * 0.3 && o.price <= mid * 3.0) {
                if (o.side === 'buy') good.buy.push(o);
                else good.sell.push(o);
            }
        }

        // Cancel duplicate extras beyond levels (keep the most recent)
        for (const side of ['buy', 'sell']) {
            while (good[side].length > levels) {
                const extra = good[side].sort((a, b) => a.id - b.id)[0];
                cancelOrder(extra.id);
                good[side] = good[side].filter(o => o.id !== extra.id);
            }
        }

        // Place missing buy orders at consistent price levels
        for (let i = 0; i < levels; i++) {
            const mult = 1 - SPREAD_PCT * (i + 1);
            const price = +(mid * mult).toFixed(PREC);
            const size = Math.round(BASE_SIZE * (1 + i * 0.5));
            const already = good.buy.find(o => o.price === price);
            if (!already) placeOrder(uid, 'buy', price, size);
        }

        // Place missing sell orders at consistent price levels
        for (let i = 0; i < levels; i++) {
            const mult = 1 + SPREAD_PCT * (i + 1);
            const price = +(mid * mult).toFixed(PREC);
            const size = Math.round(BASE_SIZE * (1 + i * 0.5));
            const already = good.sell.find(o => o.price === price);
            if (!already) placeOrder(uid, 'sell', price, size);
        }
    }
}

function getBal(userId, cur) {
    const v = psql(`
        SELECT balance FROM balances WHERE user_id=${userId} AND currency='${cur}'
    `, { tuplesOnly: true });
    return parseFloat(v || '0');
}

function executeFill(bestBuy, bestSell, size) {
    const seller = USERS.seller.id === bestSell.userId ? USERS.seller : USERS.buyer;
    const buyer = USERS.buyer.id === bestBuy.userId ? USERS.buyer : USERS.seller;
    const price = bestSell.price;
    const volume = +(price * size).toFixed(8);

    const bbLbtc = getBal(buyer.id, 'lbtc');
    const bbUsdt = getBal(buyer.id, 'usdt');
    const bsLbtc = getBal(seller.id, 'lbtc');
    const bsUsdt = getBal(seller.id, 'usdt');

    const tradeInsert = `
        INSERT INTO trades (maker_id,taker_id,maker_network_id,taker_network_id,side,price,size,quantity,symbol,pair_id,timestamp)
        VALUES (${seller.net},${buyer.net},${seller.net},${buyer.net},'buy',${price},${size},${size},'${PAIR}',${PAIR_ID},NOW()),
               (${seller.net},${buyer.net},${seller.net},${buyer.net},'sell',${price},${size},${size},'${PAIR}',${PAIR_ID},NOW())
        RETURNING id
    `;

    const sql = `
        UPDATE orders SET status='filled',accepted=true,accepted_amount=${size},updated_at=NOW()
        WHERE id=${bestBuy.id};
        UPDATE orders SET status='filled',accepted=true,accepted_amount=${size},updated_at=NOW()
        WHERE id=${bestSell.id};

        ${tradeInsert};

        UPDATE balances SET balance=balance+${volume},available=available+${volume},updated_at=NOW()
        WHERE user_id=${seller.id} AND currency='usdt';
        UPDATE balances SET balance=balance-${size},available=available-${size},updated_at=NOW()
        WHERE user_id=${seller.id} AND currency='lbtc';
        UPDATE balances SET balance=balance-${volume},available=available-${volume},updated_at=NOW()
        WHERE user_id=${buyer.id} AND currency='usdt';
        UPDATE balances SET balance=balance+${size},available=available+${size},updated_at=NOW()
        WHERE user_id=${buyer.id} AND currency='lbtc';

        INSERT INTO transactions (user_id,type,amount,currency,status,description,network)
        VALUES (${buyer.id},'trade',-${volume},'usdt','completed','Market maker buy','lbtc'),
               (${buyer.id},'trade',${size},'lbtc','completed','Market maker buy','lbtc'),
               (${seller.id},'trade',${volume},'usdt','completed','Market maker sell','lbtc'),
               (${seller.id},'trade',-${size},'lbtc','completed','Market maker sell','lbtc');
    `.replace(/\n\s+/g, '\n');
    psql(sql);

    const abLbtc = getBal(buyer.id, 'lbtc');
    const abUsdt = getBal(buyer.id, 'usdt');
    const asLbtc = getBal(seller.id, 'lbtc');
    const asUsdt = getBal(seller.id, 'usdt');

    console.log(`[MM] Trade: user${seller.id}->user${buyer.id} ${size} LBTC @ ${price} (vol ${volume})`);

    try {
        psql(`
            INSERT INTO mm_trades_log (market_maker_id, side, price, size, volume,
                buyer_id, seller_id,
                balance_before_buyer_lbtc, balance_before_buyer_usdt,
                balance_before_seller_lbtc, balance_before_seller_usdt,
                balance_after_buyer_lbtc, balance_after_buyer_usdt,
                balance_after_seller_lbtc, balance_after_seller_usdt)
            VALUES (${CFG.MM_ID}, '${bestBuy.side}', ${price}, ${size}, ${volume},
                ${buyer.id}, ${seller.id},
                ${bbLbtc}, ${bbUsdt}, ${bsLbtc}, ${bsUsdt},
                ${abLbtc}, ${abUsdt}, ${asLbtc}, ${asUsdt})
        `);
    } catch (e) {
        console.error(`[MM] Log error:`, e.message);
    }
}

function tryMatch(bestBuy, bestSell) {
    const seller = USERS.seller.id === bestSell.userId ? USERS.seller : USERS.buyer;
    const buyer = USERS.buyer.id === bestBuy.userId ? USERS.buyer : USERS.seller;

    const sellerLbtc = getBal(seller.id, 'lbtc');

    let size = Math.round(Math.min(bestBuy.size, bestSell.size, MIN_TRADE + Math.random() * (MAX_TRADE - MIN_TRADE)));
    if (sellerLbtc < size) {
        size = Math.floor(sellerLbtc * 0.9);
        if (size < 1) return false;
    }

    const price = bestSell.price;
    const volume = +(price * size).toFixed(8);

    const buyerUsdt = getBal(buyer.id, 'usdt');
    if (buyerUsdt < volume) return false;

    executeFill(bestBuy, bestSell, size);
    return true;
}

function runTrade() {
    try {
        const orders = getOpenOrders();
        const buys = orders.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price);
        const sells = orders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price);

        if (buys.length === 0 || sells.length === 0) return;

        // Phase 1: try crossing fills (buy price >= sell price, different users)
        for (const buy of buys) {
            for (const sell of sells) {
                if (buy.userId === sell.userId) continue;
                if (buy.price >= sell.price) {
                    if (tryMatch(buy, sell)) return;
                }
            }
        }

        // Phase 2: forced fill (cheapest sell with opposite user's best buy)
        for (let si = 0; si < sells.length; si++) {
            const bestSell = sells[si];
            const oppBuys = buys.filter(o => o.userId !== bestSell.userId)
                .sort((a, b) => b.price - a.price);
            if (oppBuys.length === 0) continue;
            if (tryMatch(oppBuys[0], bestSell)) return;
        }
    } catch (e) {
        console.error(`[MM] Trade error:`, e.message);
    }
}

function rebalance() {
    const bal57 = getBal(57, 'lbtc');
    const bal58 = getBal(58, 'lbtc');
    const target = Math.max(REBALANCE_THRESHOLD * 2, MAX_POSITION / 2);

    if (bal57 < REBALANCE_THRESHOLD && bal58 > REBALANCE_THRESHOLD) {
        const amount = Math.min(target - bal57, bal58 - REBALANCE_THRESHOLD);
        const transferAmount = Math.floor(Math.max(amount, 1));
        psql(`
            UPDATE balances SET balance=balance+${transferAmount}, available=available+${transferAmount}, updated_at=NOW()
            WHERE user_id=57 AND currency='lbtc';
            UPDATE balances SET balance=balance-${transferAmount}, available=available-${transferAmount}, updated_at=NOW()
            WHERE user_id=58 AND currency='lbtc';
        `);
        console.log(`[MM] Rebalance: 58->57 ${transferAmount} LBTC (57:${bal57}→${bal57+transferAmount}, 58:${bal58}→${bal58-transferAmount})`);
    } else if (bal58 < REBALANCE_THRESHOLD && bal57 > REBALANCE_THRESHOLD) {
        const amount = Math.min(target - bal58, bal57 - REBALANCE_THRESHOLD);
        const transferAmount = Math.floor(Math.max(amount, 1));
        psql(`
            UPDATE balances SET balance=balance+${transferAmount}, available=available+${transferAmount}, updated_at=NOW()
            WHERE user_id=58 AND currency='lbtc';
            UPDATE balances SET balance=balance-${transferAmount}, available=available-${transferAmount}, updated_at=NOW()
            WHERE user_id=57 AND currency='lbtc';
        `);
        console.log(`[MM] Rebalance: 57->58 ${transferAmount} LBTC (57:${bal57}→${bal57-transferAmount}, 58:${bal58}→${bal58+transferAmount})`);
    }
}

async function main() {
    console.log(`[MM] Market maker — both users both sides, ${PAIR} @ ${MID_PRICE}`);

    runCycle();
    rebalance();
    const orders = getOpenOrders();
    console.log(`[MM] Orders: ${orders.filter(o=>o.side==='buy').length} buy, ${orders.filter(o=>o.side==='sell').length} sell`);

    setInterval(() => {
        console.log(`\n[MM] Cycle`);
        runCycle();
        rebalance();
        const o = getOpenOrders();
        console.log(`[MM] Orders: ${o.filter(x=>x.side==='buy').length} buy, ${o.filter(x=>x.side==='sell').length} sell`);
    }, UPDATE_MS);

    setInterval(() => {
        runTrade();
        rebalance();
    }, TRADE_MS);

    await new Promise(() => {});
}

main().catch(e => {
    console.error('[MM] Fatal:', e.message);
    process.exit(1);
});
