'use strict';

// RVN (Ravencoin) DEPOSIT MONITOR — UTXO clone of the check-usdt-deposits.js
// flow, adapted for the node-owned address model of check-lbtc-deposits.js.
//
//   1. Watches user_wallets rows for currency 'rvn' (reloaded every cycle).
//   2. Scans blocks (getblock verbosity=2) from the cursor, journals every
//      vout paying a watched address as a PENDING hold (rvn_deposit_holds) +
//      pending deposits/transactions rows.
//   3. Credits only when the deposit is FINAL:
//        - customer deposit  : RVN_DEPOSIT_CONFIRMATIONS (default 6) AND the
//          block hash of the hold still matches the chain (reorg guard: on a
//          reorg the old block hash disappears and the hold is dropped);
//        - exchange float ('withdrawal'/'hot' purpose): direct, after
//          RVN_DIRECT_CONFIRMATIONS — the coins are already in the node wallet;
//        - other exchange-owned addresses: journalled with internal = true,
//          never credited (double count).
//   4. Sweeps/withdrawals are NOT this script's business: the node wallet owns
//      all deposit address keys, rvn-withdraw.js (phase 2) consolidates into
//      the hot address and pays withdrawals.
//
// Idempotency: unique index (deposit_tx, vout) on holds; deposits/transactions
// deduped by (tx_hash, coin_id/address/amount) — a rescan of the same range
// can never double credit (same guarantee as the LBTC/USDT monitors).
//
// Run:
//   node check-rvn-deposits.js            daemon (systemd rvn-monitor.service)
//   node check-rvn-deposits.js once       single cycle, for manual checks
//
// Config: /etc/lbtc-ops/rvn-ops.env via ../lib/rvn-rpc.js.

const fs = require('fs');
const path = require('path');
const { dbConfig, rpc, describeSources } = require('../lib/rvn-rpc');
const { Client } = require('pg');

const CURRENCY = 'rvn';
const RVN_COIN_ID = Number(process.env.RVN_COIN_ID || 33);
const MIN_CONFIRMATIONS = Math.max(1, Number(process.env.RVN_DEPOSIT_CONFIRMATIONS || 6));
const DIRECT_CONFIRMATIONS = Math.max(1, Number(process.env.RVN_DIRECT_CONFIRMATIONS || 1));
const SCAN_INTERVAL_MS = Math.max(3000, Number(process.env.RVN_SCAN_INTERVAL_MS || 15000));
// Blocks per cycle — RVN blocks are small, but a fresh watchlist after downtime
// must not eat the whole node in one pass either.
const MAX_BLOCKS_PER_CYCLE = Math.max(50, Number(process.env.RVN_MAX_BLOCKS_PER_CYCLE || 2000));

const STATE_FILE = path.join(__dirname, 'rvn-monitor-state.json');

// Purposes that ARE the exchange float: deposits arriving there are the
// exchange's own money on chain — credit the ledger directly, never "collect".
const FLOAT_PURPOSES = new Set(['withdrawal', 'hot']);
// Purposes journalled as internal (already counted when the customer got it).
const SYSTEM_PURPOSES = new Set([
    'cold', 'treasury', 'fee', 'burn', 'backup', 'locked', 'mining',
    'settlement', 'bridge', 'staking', 'audit', 'liquidity',
]);

// 1 RVN = 1e8 base units.
const BASE = 1e8;
function rvnToBase(v) { return Math.round(Number(v) * BASE); }
function fmt(base) { return (Number(base) / BASE).toFixed(8); }

function log(...args) { console.log(new Date().toISOString(), ...args); }

// --- state -------------------------------------------------------------------

let lastScannedBlock = 0;

function loadState() {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        lastScannedBlock = Number(saved.lastScannedBlock || 0);
    } catch (e) {
        lastScannedBlock = 0;
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastScannedBlock }, null, 2));
}

// --- watched addresses -------------------------------------------------------

// lowercased address -> { user_id, purpose, kind }. Reloaded every cycle so a
// freshly generated deposit address is watched the moment it appears.
let watch = new Map();

async function loadWatched() {
    const client = new Client(dbConfig());
    await client.connect();
    try {
        const rows = await client.query(
            `SELECT user_id, address, purpose FROM user_wallets
              WHERE currency = $1 AND is_valid = true
                AND address IS NOT NULL AND address <> ''
                AND LOWER(address) LIKE 'r%'`,
            [CURRENCY]
        );
        const next = new Map();
        for (const r of rows.rows) {
            const purpose = r.purpose || '';
            let kind = 'customer';
            if (FLOAT_PURPOSES.has(purpose)) kind = 'float';
            else if (SYSTEM_PURPOSES.has(purpose)) kind = 'exchange';
            next.set(String(r.address).toLowerCase(), {
                user_id: Number(r.user_id),
                purpose,
                kind,
            });
        }
        watch = next;
        const counts = { customer: 0, float: 0, exchange: 0 };
        for (const v of watch.values()) counts[v.kind]++;
        log(`watch list: ${watch.size} addresses (customer=${counts.customer}, float=${counts.float}, exchange=${counts.exchange})`);
    } finally {
        await client.end();
    }
}

// --- schema ------------------------------------------------------------------

async function ensureSchema() {
    const client = new Client(dbConfig());
    await client.connect();
    try {
        await client.query(
            `CREATE TABLE IF NOT EXISTS rvn_deposit_holds (
                id BIGSERIAL PRIMARY KEY,
                user_id INT NOT NULL,
                address TEXT NOT NULL,
                from_address TEXT,
                amount BIGINT NOT NULL,          -- base units
                deposit_tx TEXT NOT NULL,
                vout INT NOT NULL,
                block_number INT NOT NULL,
                block_hash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'held',
                internal BOOLEAN NOT NULL DEFAULT false,
                released_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`
        );
        await client.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS rvn_deposit_holds_uniq
                 ON rvn_deposit_holds (deposit_tx, vout)`
        );
        await client.query(
            `CREATE INDEX IF NOT EXISTS rvn_deposit_holds_held_idx
                 ON rvn_deposit_holds (address) WHERE status = 'held'`
        );
    } finally {
        await client.end();
    }
}

// --- journalling -------------------------------------------------------------

async function journalHold(hold) {
    const client = new Client(dbConfig());
    await client.connect();
    try {
        await client.query('BEGIN');

        const ins = await client.query(
            `INSERT INTO rvn_deposit_holds
                (user_id, address, from_address, amount, deposit_tx, vout,
                 block_number, block_hash, status, internal)
             VALUES ($1::int, $2, $3, $4::bigint, $5, $6::int, $7::int, $8, 'held', $9::boolean)
             ON CONFLICT (deposit_tx, vout) DO NOTHING
             RETURNING id`,
            [hold.user_id, hold.address, hold.from_address, hold.amount,
             hold.deposit_tx, hold.vout, hold.block_number, hold.block_hash, hold.internal]
        );
        if (ins.rowCount === 0) {
            // Already journalled (rescan after restart) — nothing new.
            await client.query('ROLLBACK');
            return false;
        }

        await client.query(
            `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address, fee, created_at, updated_at)
             VALUES ($1::int, $2::int, $3::numeric, 'pending', $4, $5, 0, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [hold.user_id, RVN_COIN_ID, fmt(hold.amount), hold.deposit_tx, hold.address]
        );
        await client.query(
            `INSERT INTO transactions
                (user_id, type, amount, currency, status, fee, fee_currency, description,
                 reference_id, tx_hash, address, network, metadata, created_at, updated_at)
             VALUES ($1::int, 'deposit', $2::numeric, $3, 'pending', 0, '', $4, NULL, $5, $6, $7, $8::jsonb, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [hold.user_id, fmt(hold.amount), CURRENCY,
             hold.internal ? 'Internal RVN transfer (not a deposit)' : 'On-chain RVN deposit',
             hold.deposit_tx, hold.address, CURRENCY,
             JSON.stringify({ vout: hold.vout, from: hold.from_address, block: hold.block_number, token: 'RVN' })]
        );
        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        await client.end();
    }
}

// --- credit ------------------------------------------------------------------

// Reorg guard: the block that holds the deposit must still be the chain tip's
// ancestor at the same height. If the hash changed, the tx was orphaned —
// drop the hold instead of crediting phantom money.
async function creditHold(hold, confsNeeded) {
    let blockHash;
    try {
        blockHash = await rpc('getblockhash', hold.block_number);
    } catch (e) {
        blockHash = null;
    }
    if (blockHash !== hold.block_hash) {
        const client = new Client(dbConfig());
        await client.connect();
        try {
            await client.query(
                `UPDATE rvn_deposit_holds
                    SET status = 'dropped', released_at = NOW(), updated_at = NOW()
                  WHERE id = $1::bigint AND status = 'held'`,
                [hold.id]
            );
            await client.query(
                `UPDATE deposits SET status = 'failed', updated_at = NOW()
                  WHERE tx_hash = $1 AND coin_id = $2::int AND address = $3 AND amount = $4::numeric
                    AND status = 'pending'`,
                [hold.deposit_tx, RVN_COIN_ID, hold.address, fmt(hold.amount)]
            );
            await client.query(
                `UPDATE transactions SET status = 'failed', updated_at = NOW()
                  WHERE tx_hash = $1 AND currency = $2 AND user_id = $3::int AND address = $4
                    AND amount = $5::numeric AND type = 'deposit' AND status = 'pending'`,
                [hold.deposit_tx, CURRENCY, hold.user_id, hold.address, fmt(hold.amount)]
            );
        } finally {
            await client.end();
        }
        log(`hold ${hold.id}: deposit ${hold.deposit_tx.slice(0, 16)}... gone from chain (reorg) — dropped`);
        return false;
    }

    if (hold.confirmations < confsNeeded) {
        log(`hold ${hold.id}: ${hold.confirmations}/${confsNeeded} confirmations, waiting`);
        return false;
    }

    const client = new Client(dbConfig());
    await client.connect();
    try {
        await client.query('BEGIN');
        const flipped = await client.query(
            `UPDATE rvn_deposit_holds
                SET status = 'released', released_at = NOW(), updated_at = NOW()
              WHERE id = $1::bigint AND status = 'held'
              RETURNING user_id, address, amount, internal`,
            [hold.id]
        );
        if (flipped.rowCount === 0) {
            await client.query('ROLLBACK');
            return false;
        }
        const h = flipped.rows[0];
        // holds хранит базовые единицы (1e8); balances/deposits/transactions —
        // дисплей-единицы RVN (как amountText в LBTC-скрипте).
        const amount = fmt(h.amount);
        const userId = Number(h.user_id);

        // Exchange-owned non-float wallets are journalled but never credited —
        // that money was already credited when the customer received it.
        if (h.internal !== true) {
            const upd = await client.query(
                `UPDATE balances
                    SET balance = balance + $1::numeric, available = available + $1::numeric, updated_at = NOW()
                  WHERE user_id = $2::int AND currency = $3`,
                [amount, userId, CURRENCY]
            );
            if (upd.rowCount === 0) {
                await client.query(
                    `INSERT INTO balances (user_id, currency, balance, available, locked, updated_at)
                     VALUES ($1::int, $2, $3::numeric, $3::numeric, 0, NOW())
                     ON CONFLICT (user_id, currency) DO UPDATE
                        SET balance = balances.balance + EXCLUDED.balance,
                            available = balances.available + EXCLUDED.available,
                            updated_at = NOW()`,
                    [userId, CURRENCY, amount]
                );
            }
        }

        const dep = await client.query(
            `UPDATE deposits SET status = 'completed', updated_at = NOW()
              WHERE tx_hash = $1 AND coin_id = $2::int AND address = $3 AND amount = $4::numeric
              RETURNING id`,
            [hold.deposit_tx, RVN_COIN_ID, hold.address, amount]
        );
        if (dep.rowCount === 0) {
            await client.query(
                `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address, fee, created_at, updated_at)
                 VALUES ($1::int, $2::int, $3::numeric, 'completed', $4, $5, 0, NOW(), NOW())
                 ON CONFLICT DO NOTHING`,
                [userId, RVN_COIN_ID, amount, hold.deposit_tx, hold.address]
            );
        }
        const tx = await client.query(
            `UPDATE transactions SET status = 'completed', updated_at = NOW()
              WHERE tx_hash = $1 AND currency = $2 AND user_id = $3::int AND address = $4
                AND amount = $5::numeric AND type = 'deposit'
              RETURNING id`,
            [hold.deposit_tx, CURRENCY, userId, hold.address, amount]
        );
        if (tx.rowCount === 0) {
            await client.query(
                `INSERT INTO transactions
                    (user_id, type, amount, currency, status, fee, fee_currency, description,
                     reference_id, tx_hash, address, network, metadata, created_at, updated_at)
                 VALUES ($1::int, 'deposit', $2::numeric, $3, 'completed', 0, '', $4, NULL, $5, $6, $7, $8::jsonb, NOW(), NOW())
                 ON CONFLICT DO NOTHING`,
                [userId, amount, CURRENCY,
                 h.internal === true ? 'Internal RVN transfer (not a deposit)' : 'On-chain RVN deposit',
                 hold.deposit_tx, hold.address, CURRENCY,
                 JSON.stringify({ vout: hold.vout, from: hold.from_address, block: hold.block_number, token: 'RVN' })]
            );
        }
        log(`hold ${hold.id}: credited ${fmt(hold.amount)} RVN to user ${userId}` +
            (h.internal === true ? ' (internal, journal only)' : ''));
        // Клиентский адрес зеркалит ledger пользователя (как в LBTC-мониторе):
        // иначе user_wallets.balance обнуляется при сборе в float.
        if (h.internal !== true) {
            const bal = await client.query(
                `SELECT balance, available FROM balances WHERE user_id = $1::int AND currency = $2`,
                [userId, CURRENCY]
            );
            if (bal.rows.length > 0) {
                await client.query(
                    `UPDATE user_wallets
                        SET balance = $1::numeric, available = $2::numeric, updated_at = NOW()
                      WHERE address = $3 AND currency = $4`,
                    [bal.rows[0].balance, bal.rows[0].available, hold.address, CURRENCY]
                );
            }
        }
        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        await client.end();
    }
}

// Held holds -> credit/drop, oldest first.
async function releaseHolds() {
    const client = new Client(dbConfig());
    let rows;
    await client.connect();
    try {
        rows = (await client.query(
            `SELECT id, user_id, address, from_address, amount, deposit_tx, vout,
                    block_number, block_hash, internal
               FROM rvn_deposit_holds
              WHERE status = 'held'
              ORDER BY id`
        )).rows;
    } finally {
        await client.end();
    }
    if (rows.length === 0) return;
    const latest = Number(await rpc('getblockcount'));
    for (const row of rows) {
        const confs = latest - Number(row.block_number) + 1;
        const w = watch.get(String(row.address).toLowerCase()) || {};
        const kind = row.internal === true ? 'exchange' : (w.kind || 'customer');
        const needed = kind === 'customer' ? MIN_CONFIRMATIONS : DIRECT_CONFIRMATIONS;
        await creditHold(
            {
                id: row.id, user_id: row.user_id, address: row.address,
                from_address: row.from_address, amount: Number(row.amount),
                deposit_tx: row.deposit_tx, vout: row.vout,
                block_number: Number(row.block_number), block_hash: row.block_hash,
                internal: row.internal === true,
                confirmations: confs,
            },
            needed
        );
    }
}

// --- block scan --------------------------------------------------------------

async function scanBlock(height) {
    const hash = await rpc('getblockhash', height);
    const block = await rpc('getblock', hash, 2);
    let found = 0;
    for (const tx of block.tx || []) {
        // Coinbase outputs belong to miners; skip entirely.
        if (tx.vin && tx.vin[0] && tx.vin[0].coinbase) continue;
        const from = (tx.vin || [])
            .map(v => v.prevout && v.prevout.address)
            .find(a => typeof a === 'string') || null;
        for (const vout of tx.vout || []) {
            const addr = vout.scriptPubKey && (
                (vout.scriptPubKey.addresses && vout.scriptPubKey.addresses[0]) ||
                (vout.scriptPubKey.address || null)
            );
            if (!addr) continue;
            const w = watch.get(String(addr).toLowerCase());
            if (!w) continue;
            const amount = rvnToBase(vout.value);
            if (amount <= 0) continue;
            const internal = w.kind !== 'customer';
            const journalled = await journalHold({
                user_id: w.user_id,
                address: addr,
                from_address: from,
                amount,
                deposit_tx: tx.txid,
                vout: vout.n,
                block_number: height,
                block_hash: hash,
                internal,
            });
            if (journalled) {
                found++;
                log(`block ${height}: ${internal ? 'internal' : 'deposit'} ${fmt(amount)} RVN -> ${addr} (user ${w.user_id}, tx ${tx.txid})`);
            }
        }
    }
    return found;
}

async function runCycle() {
    await loadWatched();
    const latest = Number(await rpc('getblockcount'));
    if (lastScannedBlock <= 0) {
        // Start from a recent block, never from genesis: only transfers arriving
        // AFTER the monitor went live can be deposits.
        lastScannedBlock = Math.max(0, latest - MIN_CONFIRMATIONS - 5);
        saveState();
        log(`initialized at block ${lastScannedBlock}`);
        return;
    }
    if (latest <= lastScannedBlock) return;

    const fromBlock = lastScannedBlock + 1;
    const toBlock = Math.min(latest, lastScannedBlock + MAX_BLOCKS_PER_CYCLE);
    let found = 0;
    let scannedTo = lastScannedBlock;
    for (let h = fromBlock; h <= toBlock; h++) {
        found += await scanBlock(h);
        scannedTo = h;
    }
    // Only advance the cursor over blocks that were actually scanned; a failed
    // block stops the pass and the remainder is picked up on the next cycle.
    if (scannedTo > lastScannedBlock) {
        lastScannedBlock = scannedTo;
        saveState();
    }
    if (found > 0) log(`blocks ${fromBlock}..${scannedTo}: ${found} vout(s) to watched addresses`);

    await releaseHolds();
}

async function main() {
    loadState();
    await ensureSchema();
    log(`RVN deposit monitor starting (mode=${process.argv[2] || 'daemon'}, confirmations=${MIN_CONFIRMATIONS}, coin_id=${RVN_COIN_ID}, rpc: ${describeSources()})`);
    if (process.argv[2] === 'once') {
        await runCycle();
        return;
    }
    const loop = () => runCycle()
        .catch(e => log(`cycle error: ${e.message}`))
        .finally(() => setTimeout(loop, SCAN_INTERVAL_MS));
    loop();
}

if (require.main === module) {
    main().catch(e => {
        console.error(`Fatal: ${e.message}`);
        process.exit(1);
    });
}

module.exports = { runCycle, loadWatched, scanBlock, journalHold, creditHold, ensureSchema };
