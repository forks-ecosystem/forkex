'use strict';

// USDT (ERC-20 Ethereum mainnet) DEPOSIT MONITOR — the ERC-20 counterpart of
// check-lbtc-deposits.js.
//
// The deposit address itself holds the tokens: an ERC-20 deposit is not an
// ETH transaction with `to` = user address, it is a Transfer(from, to, value)
// LOG emitted by the USDT contract (0xdAC17F...31ec7), decimals = 6. A monitor
// that only watches eth_getBalance / native transfers sees nothing — deposits
// arrive on chain but the exchange shows 0 (doc187/doc193). This process:
//
//   1. eth_getLogs over the USDT contract for Transfer logs whose `to`
//      (topic2) is one of the watched addresses (user_wallets, currency usdt).
//   2. Journals every transfer as PENDING (hold ledger + deposits +
//      transactions), like the LBTC wallet scanner does.
//   3. Credits the customer's `balances` ledger only when the deposit block
//      has >= USDT_DEPOSIT_CONFIRMATIONS (default 12) confirmations, verified
//      against the live receipt — a reorged deposit is dropped, not credited.
//   4. Keeps the per-address mirror (user_wallets.balance) in step: customer
//      rows mirror the LEDGER at credit time (coins may be swept to the hot
//      wallet later without touching the mirror), exchange-owned rows
//      (hot/fee/withdrawal/...) mirror the raw on-chain balanceOf value.
//
// What is NEVER credited:
//   - transfers INTO an exchange-owned wallet (they are the exchange's own
//     coins moving around: sweeps, consolidations, fee moves) — journalled
//     with internal = true, so an audit can follow them;
//   - a repeat of the same (tx, address, logIndex) — the unique index makes
//     every step idempotent, so scanner and monitor cannot double-credit.
//
// Run:
//   node check-usdt-deposits.js            (daemon, one cycle per 15 s)
//   node check-usdt-deposits.js once       (single cycle, for manual checks)
//
// Config: /etc/lbtc-ops/usdt-ops.env via usdt-lib.js.

const { dbConfig, rpc, USDT_CONTRACT, USDT_COIN_ID, TRANSFER_TOPIC, DEPOSIT_CONFIRMATIONS, addressTopic, toBig, baseToAmountText } = require('./usdt-lib');

const CURRENCY = 'usdt';
const SCAN_INTERVAL_MS = 15 * 1000;
const BALANCE_SYNC_INTERVAL_MS = 3 * 60 * 1000;
// eth_getLogs is polled in block chunks. Public endpoints reject very wide
// ranges; this starts conservative and halves itself if the endpoint objects.
const GETLOGS_CHUNK_START = 400;
const TOPICS_PER_QUERY = 400;
const STATE_FILE = __dirname + '/usdt-monitor-state.json';

// user_wallets purposes that belong to the exchange itself are the mirror of
// this rule on the DB side: money arriving on those addresses is already
// exchange money (sweeps of customer deposits, treasury moves), so it is
// journalled but not credited — crediting would double-count every swept
// deposit. See WATCHED in loadWatched(): purpose '' -> customer, anything
// else -> exchange.

// PostgreSQL: prefer the published port of the forkex-db container, fall back
// to the live container IP (same strategy as check-lbtc-deposits.js).
const DB_AUTH = dbConfig();
let dbTarget = null;

function containerIp(name) {
    try {
        return require('child_process')
            .execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${name}`,
                { encoding: 'utf8', timeout: 5000 })
            .trim() || null;
    } catch (e) {
        return null;
    }
}

function dbCandidates() {
    const list = [];
    if (process.env.USDT_MONITOR_DB_HOST) {
        list.push({ host: process.env.USDT_MONITOR_DB_HOST, port: Number(process.env.USDT_MONITOR_DB_PORT || 5432) });
    }
    list.push({ host: '127.0.0.1', port: 5434 });
    const ip = containerIp('forkex-db');
    if (ip) list.push({ host: ip, port: 5432 });
    return list;
}

async function connectDb() {
    const { Client } = require('pg');
    const candidates = dbTarget ? [dbTarget] : dbCandidates();
    let lastErr = null;
    for (const target of candidates) {
        const client = new Client({ ...target, ...DB_AUTH, connectionTimeoutMillis: 5000 });
        try {
            await client.connect();
            dbTarget = target;
            return client;
        } catch (e) {
            lastErr = e;
            try { await client.end(); } catch (_) {}
        }
    }
    throw lastErr || new Error('no reachable database');
}

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

// --- state ------------------------------------------------------------------

let lastScannedBlock = 0;
let logsChunk = GETLOGS_CHUNK_START;

function loadState() {
    try {
        const saved = JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8'));
        lastScannedBlock = Number(saved.lastScannedBlock || 0);
    } catch (e) {
        lastScannedBlock = 0;
    }
}

function saveState() {
    require('fs').writeFileSync(STATE_FILE, JSON.stringify({ lastScannedBlock }, null, 2));
}

// --- watched addresses ------------------------------------------------------

// lowercased address -> { user_id, purpose, kind }. Reloaded every cycle so a
// new deposit address is watched the moment it appears, with no restart.
let WATCHED = {};
let watchedSig = '';

async function loadWatched() {
    const client = await connectDb();
    try {
        const res = await client.query(
            `SELECT user_id, address, purpose FROM user_wallets
              WHERE currency = $1 AND is_valid = true
                AND address IS NOT NULL AND address <> ''
                AND LOWER(address) LIKE '0x%'`,
            [CURRENCY]
        );
        const next = {};
        const sigParts = [];
        for (const r of res.rows) {
            const address = String(r.address).toLowerCase();
            const purpose = (r.purpose || '').trim();
            const kind = purpose === '' ? 'customer' : 'exchange';
            next[address] = { user_id: Number(r.user_id), purpose, kind };
            sigParts.push(`${address}:${purpose}`);
        }
        const sig = sigParts.sort().join('|');
        if (sig !== watchedSig) {
            const customers = Object.values(next).filter(w => w.kind === 'customer').length;
            log(`watched addresses: ${Object.keys(next).length} (${customers} customer)`);
            watchedSig = sig;
        }
        WATCHED = next;
    } finally {
        await client.end();
    }
}

// --- schema -----------------------------------------------------------------

async function ensureSchema() {
    const client = await connectDb();
    try {
        await client.query(
            `CREATE TABLE IF NOT EXISTS usdt_deposit_holds (
                 id bigserial PRIMARY KEY,
                 user_id integer NOT NULL,
                 address varchar NOT NULL,
                 from_address varchar NOT NULL DEFAULT '',
                 amount numeric(32,16) NOT NULL,
                 deposit_tx varchar NOT NULL,
                 log_index integer NOT NULL DEFAULT 0,
                 block_number bigint NOT NULL DEFAULT 0,
                 status varchar NOT NULL DEFAULT 'held',
                 internal boolean NOT NULL DEFAULT false,
                 created_at timestamptz NOT NULL DEFAULT now(),
                 released_at timestamptz
             )`);
        await client.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS usdt_deposit_holds_deposit_uniq
                 ON usdt_deposit_holds (deposit_tx, address, log_index)`);
        await client.query(
            `CREATE INDEX IF NOT EXISTS usdt_deposit_holds_held_idx
                 ON usdt_deposit_holds (address) WHERE status = 'held'`);
    } finally {
        await client.end();
    }
}

// --- ledger writes ----------------------------------------------------------

// Journal a transfer as PENDING. Nothing is credited here; credit happens in
// releaseHold once the deposit block has enough confirmations.
async function journalHold(transfer) {
    const client = await connectDb();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO usdt_deposit_holds (user_id, address, from_address, amount, deposit_tx, log_index, block_number)
             VALUES ($1, $2, $3, $4::numeric, $5, $6, $7)
             ON CONFLICT (deposit_tx, address, log_index) DO NOTHING`,
            [transfer.userId, transfer.address, transfer.from, transfer.amountText, transfer.txHash, transfer.logIndex, transfer.blockNumber]
        );
        await client.query(
            `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address, fee, created_at, updated_at)
             VALUES ($1, $2::int, $3::numeric, 'processing', $4, $5, 0, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [transfer.userId, USDT_COIN_ID, transfer.amountText, transfer.txHash, transfer.address]
        );
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
             VALUES ($1::int, 'deposit', $2::numeric, $3, 'pending', 0, '', 'On-chain USDT deposit', NULL, $4, $5, 'eth', $6::jsonb, NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [transfer.userId, transfer.amountText, CURRENCY, transfer.txHash, transfer.address,
             JSON.stringify({ contract: USDT_CONTRACT, log_index: transfer.logIndex, block_number: transfer.blockNumber, from: transfer.from, token: 'USDT' })]
        );
        await client.query('COMMIT');
        log(`deposit pending: user=${transfer.userId} ${transfer.amountText} USDT tx=${transfer.txHash.slice(0, 16)}... log=${transfer.logIndex}`);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        await client.end();
    }
}

// The credit step. Verifies against the LIVE receipt: same block as the log
// and at least DEPOSIT_CONFIRMATIONS blocks mined since. A receipt that
// disappeared (reorg) drops the hold instead of crediting phantom money.
async function releaseHold(hold) {
    const receipt = await rpc('eth_getTransactionReceipt', [hold.deposit_tx]);
    if (!receipt) {
        const client = await connectDb();
        try {
            await client.query('BEGIN');
            await client.query(`UPDATE usdt_deposit_holds SET status = 'dropped', released_at = NOW() WHERE id = $1::bigint AND status = 'held'`, [hold.id]);
            await client.query(
                `UPDATE transactions SET status = 'failed',
                        description = 'USDT deposit dropped: transaction vanished (reorg)',
                        updated_at = NOW()
                  WHERE tx_hash = $1 AND currency = $2 AND user_id = $3::int AND address = $4 AND amount = $5::numeric AND type = 'deposit'`,
                [hold.deposit_tx, CURRENCY, hold.user_id, hold.address, hold.amount]
            );
            await client.query(
                `UPDATE deposits SET status = 'failed', updated_at = NOW()
                  WHERE tx_hash = $1 AND coin_id = $2::int AND address = $3 AND amount = $4::numeric`,
                [hold.deposit_tx, USDT_COIN_ID, hold.address, hold.amount]
            );
            await client.query('COMMIT');
            log(`hold ${hold.id}: deposit ${hold.deposit_tx.slice(0, 16)}... gone from chain (reorg) — dropped`);
        } finally {
            await client.end();
        }
        return false;
    }

    const minedBlock = toBig(receipt.blockNumber);
    const latest = toBig(await rpc('eth_blockNumber', []));
    const confs = Number(latest - minedBlock) + 1;
    if (confs < DEPOSIT_CONFIRMATIONS || Number(minedBlock) !== Number(hold.block_number)) {
        log(`hold ${hold.id}: ${confs}/${DEPOSIT_CONFIRMATIONS} confirmations (block ${minedBlock}), waiting`);
        return false;
    }

    const client = await connectDb();
    try {
        await client.query('BEGIN');
        const flipped = await client.query(
            `UPDATE usdt_deposit_holds
                SET status = 'released', released_at = NOW()
              WHERE id = $1::bigint AND status = 'held'
              RETURNING id, user_id, amount, address, from_address, internal`,
            [hold.id]
        );
        if (flipped.rowCount === 0) {
            await client.query('ROLLBACK');
            return false;
        }
        const h = flipped.rows[0];
        const amount = String(h.amount);
        const userId = Number(h.user_id);
        const internal = h.internal === true;

        // Transfers into exchange-owned wallets (sweeps, treasury moves) are
        // journalled but not credited — that money was already credited when
        // the customer received it.
        if (!internal) {
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
            [hold.deposit_tx, USDT_COIN_ID, hold.address, amount]
        );
        if (dep.rowCount === 0) {
            await client.query(
                `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address, fee, created_at, updated_at)
                 VALUES ($1::int, $2::int, $3::numeric, 'completed', $4, $5, 0, NOW(), NOW())
                 ON CONFLICT DO NOTHING`,
                [userId, USDT_COIN_ID, amount, hold.deposit_tx, hold.address]
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
                `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
                 VALUES ($1::int, 'deposit', $2::numeric, $3, 'completed', 0, '', 'On-chain USDT deposit', NULL, $4, $5, 'eth', $6::jsonb, NOW(), NOW())
                 ON CONFLICT DO NOTHING`,
                [userId, amount, CURRENCY, hold.deposit_tx, hold.address,
                 JSON.stringify({ contract: USDT_CONTRACT, log_index: hold.log_index, from: h.from_address, token: 'USDT' })]
            );
        }
        if (internal) {
            await client.query(
                `UPDATE transactions
                    SET description = 'Internal USDT transfer (not a deposit)',
                        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('internal', true, 'marked_by', 'usdt-deposit-monitor', 'marked_at', now()::text),
                        updated_at = NOW()
                  WHERE tx_hash = $1 AND currency = $2 AND user_id = $3::int
                    AND address = $4 AND amount = $5::numeric AND type = 'deposit'`,
                [hold.deposit_tx, CURRENCY, userId, hold.address, amount]
            );
        } else {
            // Customer deposit address mirrors the customer's ledger, not the
            // raw on-chain value: the tokens may already have been swept into
            // the hot wallet while the ledger still owes the user the money
            // (same rule as the LBTC monitor — mirroring raw chain state here
            // wiped users 57/58 in the LBTC era).
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
        log(`  -> RELEASED ${amount} USDT | user ${userId} | deposit ${hold.deposit_tx.slice(0, 12)}...${internal ? ' | internal, not credited' : ''}`);
        return true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log(`  -> release failed for hold ${hold.id}: ${err.message}`);
        return false;
    } finally {
        await client.end();
    }
}

async function processHolds() {
    const client = await connectDb();
    let holds;
    try {
        const res = await client.query(
            `SELECT id, user_id, address, amount, deposit_tx, log_index, block_number
               FROM usdt_deposit_holds
              WHERE status = 'held'
              ORDER BY id`
        );
        holds = res.rows;
    } finally {
        await client.end();
    }
    for (const h of holds) {
        const w = WATCHED[String(h.address).toLowerCase()];
        // Exchange-owned wallets (hot/fee/withdrawal/...): that money was
        // already credited when the customer received it, so a transfer INTO
        // such a wallet is journalled with internal = true and never credited.
        if (w && w.kind === 'exchange') {
            const c = await connectDb();
            try {
                await c.query(`UPDATE usdt_deposit_holds SET internal = true WHERE id = $1::bigint AND internal = false`, [h.id]);
            } finally {
                await c.end();
            }
        }
        try {
            await releaseHold(h);
        } catch (e) {
            // One unreadable receipt must not stall the whole hold queue;
            // the hold stays 'held' and is retried next cycle.
            log(`hold ${h.id}: release error (will retry): ${e.message.slice(0, 120)}`);
        }
    }
}

// --- block scanning ---------------------------------------------------------

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

function looksLikeRangeError(message) {
    return /more than|limit|too (large|many)|exceed|10000|range|archive|window/i.test(String(message));
}

async function getLogs(fromBlock, toBlock, addresses) {
    const groups = chunk(addresses, TOPICS_PER_QUERY);
    const out = [];
    for (const group of groups) {
        const logs = await rpc('eth_getLogs', [{
            fromBlock: '0x' + fromBlock.toString(16),
            toBlock: '0x' + toBlock.toString(16),
            address: USDT_CONTRACT,
            topics: [TRANSFER_TOPIC, null, group.map(addressTopic)],
        }]);
        if (Array.isArray(logs)) out.push(...logs);
    }
    return out;
}

async function scanRange(fromBlock, toBlock) {
    const addresses = Object.keys(WATCHED);
    const found = { count: 0, scannedTo: fromBlock - 1 };
    if (addresses.length === 0) return found;

    for (let start = fromBlock; start <= toBlock; start += logsChunk) {
        const end = Math.min(start + logsChunk - 1, toBlock);
        let logs;
        try {
            logs = await getLogs(start, end, addresses);
        } catch (e) {
            if (looksLikeRangeError(e.message) && logsChunk > 50) {
                // Public endpoints reject wide ranges. Shrink the chunk and
                // stop the pass here; the next cycle rescans from where this
                // one stopped, so no block is ever skipped.
                logsChunk = Math.floor(logsChunk / 2);
                log(`getLogs range rejected, chunk reduced to ${logsChunk}: ${e.message.slice(0, 120)}`);
                return found;
            }
            throw e;
        }
        for (const lg of logs) {
            const toTopic = (lg.topics && lg.topics[2]) || '';
            const address = '0x' + toTopic.slice(26);
            const w = WATCHED[address.toLowerCase()];
            if (!w) continue;
            const from = lg.topics && lg.topics[1] ? '0x' + lg.topics[1].slice(26) : '';
            const rawValue = toBig(lg.data === '0x' ? '0x0' : lg.data);
            if (rawValue <= 0n) continue;
            const txHash = lg.transactionHash;
            if (!txHash) continue;
            await journalHold({
                userId: w.user_id,
                address,
                from,
                amountText: baseToAmountText(rawValue),
                txHash,
                logIndex: Number(lg.logIndex || 0),
                blockNumber: Number(toBig(lg.blockNumber)),
            });
            found.count++;
        }
        found.scannedTo = end;
    }
    return found;
}

// --- balance mirrors --------------------------------------------------------

async function balanceOf(address) {
    // balanceOf(address): selector 0x70a08231 + 32-byte padded address
    // (doc186 walks through this call in detail).
    const data = '0x70a08231000000000000000000000000' + address.toLowerCase().replace(/^0x/, '');
    const res = await rpc('eth_call', [{ to: USDT_CONTRACT, data }, 'latest']);
    return res && res !== '0x' ? toBig(res) : 0n;
}

async function syncWatchedBalances() {
    const client = await connectDb();
    let changed = 0, failed = 0, rows = [];
    try {
        // Only exchange-owned rows mirror raw chain state. Customer rows are
        // ledger mirrors and are written at credit time.
        const res = await client.query(
            `SELECT id, address FROM user_wallets
              WHERE currency = $1 AND is_valid = true
                AND address IS NOT NULL AND address <> ''
                AND LOWER(address) LIKE '0x%'
                AND purpose IS NOT NULL AND purpose <> ''`,
            [CURRENCY]
        );
        rows = res.rows;
    } finally {
        await client.end();
    }
    for (const r of rows) {
        let text = '0.0000000000000000';
        try {
            text = baseToAmountText(await balanceOf(r.address));
        } catch (e) {
            failed++;
            continue;
        }
        try {
            const c = await connectDb();
            try {
                const u = await c.query(
                    `UPDATE user_wallets
                        SET balance = $1::numeric, available = $1::numeric, updated_at = NOW()
                      WHERE id = $2::int AND currency = $3
                        AND (balance IS DISTINCT FROM $1::numeric OR available IS DISTINCT FROM $1::numeric)`,
                    [text, r.id, CURRENCY]
                );
                if (u.rowCount > 0) changed++;
            } finally {
                await c.end();
            }
        } catch (e) {
            failed++;
        }
    }
    if (rows.length > 0) log(`sync exchange wallet mirrors: ${changed}/${rows.length} changed (${failed} unreadable)`);
}

// --- main loop --------------------------------------------------------------

let lastBalanceSyncAt = 0;

async function runCycle() {
    await loadWatched();
    const latest = Number(toBig(await rpc('eth_blockNumber', [])));
    if (lastScannedBlock <= 0) {
        // Start from a recent finalized block, never from genesis: the USDT
        // mainnet history is enormous and irrelevant — only transfers arriving
        // AFTER the monitor went live can be deposits.
        lastScannedBlock = Math.max(0, latest - DEPOSIT_CONFIRMATIONS - 5);
        saveState();
        log(`initialized at block ${lastScannedBlock}`);
        return;
    }
    if (latest <= lastScannedBlock) return;

    const fromBlock = lastScannedBlock + 1;
    const toBlock = Math.min(latest, lastScannedBlock + 2000); // cap catch-up per cycle
    const { count, scannedTo } = await scanRange(fromBlock, toBlock);
    // Only advance the cursor over blocks that were actually scanned: a
    // rejected getLogs range stops the pass mid-window and the remainder is
    // picked up on the next cycle.
    lastScannedBlock = Math.max(lastScannedBlock, scannedTo);
    saveState();
    if (count > 0) log(`blocks ${fromBlock}..${scannedTo}: ${count} transfer(s) to watched addresses (chunk=${logsChunk})`);

    await processHolds();

    const now = Date.now();
    if (now - lastBalanceSyncAt >= BALANCE_SYNC_INTERVAL_MS) {
        lastBalanceSyncAt = now;
        await syncWatchedBalances();
    }
}

async function main() {
    loadState();
    await ensureSchema();
    await loadWatched();
    const mode = process.argv[2] || 'daemon';
    log(`USDT deposit monitor starting (mode=${mode}, confirmations=${DEPOSIT_CONFIRMATIONS}, contract=${USDT_CONTRACT})`);
    if (mode === 'once') {
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

module.exports = { runCycle, loadWatched, balanceOf, journalHold, releaseHold, ensureSchema };
