'use strict';

const http = require('http');
const { rpcConfig, dbConfig } = require('./lbtc-ops-env');
const crypto = require('crypto');

const CURRENCY = 'lbtc';
const MIN_CONFIRMATIONS = 3;
const RPC_DELAY_MS = 350;
// Deposit addresses live in the node's `users` wallet (older ones in `bots`).
// Every customer deposit is collected from the user's address into the
// dedicated staging address of the `users` float, so the on-chain users wallet
// mirrors the liabilities the withdrawal staging step spends from.
const USER_WALLET = process.env.LBTC_USER_WALLET || 'users';
const SWEEP_WALLETS = [...new Set([USER_WALLET, 'bots'])];
const WITHDRAWAL_ADDR = process.env.LBTC_WITHDRAWAL_ADDR || 'LbatPBt1z7jTp6u4ikgbRL46XLRtA6ZaxX';
const LBTC_COIN_ID = Number(process.env.LBTC_COIN_ID || 23);
// The float account: its ledger balance is the coin side of the exchange and
// the withdrawal flow debits it, so deposits that land on the float address
// are credited to it.
const FLOAT_USER_ID = Number(process.env.LBTC_FLOAT_USER_ID || 1);
// sweepallraw base-unit fee: 1000 sompi (~min relay 1000/KB).
const SWEEP_FEE_BASE_UNITS = Number(process.env.LBTC_SWEEP_FEE_BASE_UNITS || 1000);
// Confirmations of the user's deposit tx before the coins are collected into
// the float. The collect needs a confirmed UTXO to spend.
const DEPOSIT_CONFIRMATIONS = Math.max(1, Number(process.env.LBTC_DEPOSIT_CONFIRMATIONS || MIN_CONFIRMATIONS));
// Confirmations of the collect tx before the balance is credited. This is the
// gate the whole flow exists for: the money must be FINAL in the float before
// the customer can spend it.
const COLLECT_CONFIRMATIONS = Math.max(1, Number(process.env.LBTC_COLLECT_CONFIRMATIONS || 3));
// Addresses the exchange owns itself (the float and the system wallets) hold
// the money already, so they are credited straight away and never collected.
// Bot deposit addresses are credited straight away too, but their coins are
// still collected into the float afterwards.
const DIRECT_CONFIRMATIONS = Math.max(1, Number(process.env.LBTC_DIRECT_CONFIRMATIONS || 1));
const SYSTEM_PURPOSES = new Set([
    'hot', 'cold', 'treasury', 'fee', 'burn', 'backup', 'locked', 'mining',
    'settlement', 'bridge', 'staking', 'audit', 'liquidity', 'withdrawal',
]);
const RECONCILE_USERS = (process.env.LBTC_RECONCILE_USERS || '100,101,102,103,104,105,106,107,108,109')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);

// How a watched address is treated. The kind decides WHEN the balance moves,
// and it is derived from user_wallets, not guessed:
//   float     - the exchange float (the withdrawal address). The coins are
//               already in the float's chain balance, so they are credited to
//               the float ledger directly and never collected again.
//   exchange  - the exchange's other wallets. Journaled, never credited (they
//               are not customer money), never collected.
//   bot       - operational deposit addresses. Credited directly, then
//               collected into the float so the float can spend them.
//   customer  - a customer's own deposit address. The coins are collected into
//               the float first and the customer is credited only once that
//               collect is final on chain.
const KIND_FLOAT = 'float';
const KIND_EXCHANGE = 'exchange';
const KIND_BOT = 'bot';
const KIND_CUSTOMER = 'customer';

// user_wallets.balance is a per-address on-chain mirror. It is refreshed this
// often so moves made outside the monitor (withdrawal staging, consolidation)
// do not leave the record stale against the chain.
const BALANCE_SYNC_INTERVAL_MS = 3 * 60 * 1000;
let lastBalanceSyncAt = 0;

// Watched addresses -> { userId, purpose, kind }. Reloaded from user_wallets
// on every cycle, so per-user deposit addresses are picked up without a code
// change.
let WATCHED = {};
let lastWatchedSig = '';

let lastCheckedHeight = 0;

// PostgreSQL: prefer the published port of the forkex-db container (survives
// container recreates), fall back to the live container IP.
const RPC = rpcConfig();
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
    if (process.env.LBTC_MONITOR_DB_HOST) {
        list.push({ host: process.env.LBTC_MONITOR_DB_HOST, port: Number(process.env.LBTC_MONITOR_DB_PORT || 5432) });
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

const STATE_FILE = __dirname + '/lbtc-monitor-state.json';

function loadState() {
    try {
        const saved = JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8'));
        lastCheckedHeight = saved.lastCheckedHeight || 0;
    } catch (e) {
        lastCheckedHeight = 0;
    }
}

function saveState() {
    try {
        require('fs').writeFileSync(STATE_FILE, JSON.stringify({
            lastCheckedHeight,
        }, null, 2));
    } catch (e) {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sleepMs = async () => {
    await sleep(RPC_DELAY_MS);
};

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function rpcCall(method, params = [], wallet) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '1.0', method, params, id: Date.now() });
        const opts = {
            hostname: RPC.host,
            port: RPC.port,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${RPC.user}:${RPC.password}`).toString('base64'),
                'Content-Length': Buffer.byteLength(body),
            },
        };
        if (wallet) opts.headers['X-LegacyCoin-Wallet'] = wallet;
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) reject(new Error(json.error.message));
                    else resolve(json.result);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// rpcCallE retries politely on HTTP 429 (too many requests) so the monitor
// stays within the node rate limit even when the node is busy.
async function rpcCallE(method, params = [], wallet) {
    for (let attempt = 0; attempt < 8; attempt++) {
        if (attempt > 0) await sleep(RPC_DELAY_MS * attempt);
        try {
            const v = await rpcCall(method, params, wallet);
            return v;
        } catch (e) {
            const is429 = /too many requests/i.test(String(e.message));
            if (!is429) throw e;
        }
    }
    throw new Error(`${method} still rate-limited after retries`);
}

// Amounts are compared and indexed as decimals, so they must be written the
// same way everywhere: 8 decimals, no exponent, no float noise. 1234 and
// 1234.00000000 are the same number to Postgres but not the same string.
const amountText = (value) => Number(value).toFixed(8);

// Deposit addresses -> owner + kind, straight from the exchange DB. Rows
// without a purpose (exchange wallets) win over per-user rows when an address
// is shared, so the hot wallet keeps crediting the account it always credited.
async function loadWatched() {
    const client = await connectDb();
    try {
        // network IN ('lbtc','main'), not network = 'lbtc': 12 of the exchange's
        // own lbtc wallets (hot, cold, treasury, deposit, withdrawal, fee,
        // bridge, mining, ...) carry network='main' and were therefore invisible
        // here. Coins parked in hot/treasury - which is where the exchange's own
        // treasury funding lands - would never be seen and their cached balance
        // would stay at 0 while the money sat on-chain. Verified: all 35 active
        // lbtc addresses live on the same chain, so currency is the discriminator.
        const res = await client.query(
            `SELECT address, user_id, purpose FROM user_wallets
              WHERE currency = $1 AND network IN ($1, 'main')
                AND status = 'active' AND is_valid = true
                AND address IS NOT NULL AND address <> ''
              ORDER BY (purpose IS NULL OR purpose = '') DESC, id ASC`,
            [CURRENCY]
        );
        const next = {};
        const dupes = [];
        for (const row of res.rows) {
            if (next[row.address] !== undefined) {
                dupes.push(`${row.address} -> user ${row.user_id} ignored, user ${next[row.address].userId} kept`);
                continue;
            }
            next[row.address] = {
                userId: Number(row.user_id),
                purpose: row.purpose || null,
                kind: classifyAddress(row.address, Number(row.user_id), row.purpose || null),
            };
        }
        const sig = JSON.stringify(next);
        if (sig !== lastWatchedSig) {
            log(`watched addresses: ${Object.keys(WATCHED).length} -> ${Object.keys(next).length}`);
            for (const d of dupes) log(`shared address: ${d}`);
            lastWatchedSig = sig;
        }
        WATCHED = next;
        return Object.keys(WATCHED).length;
    } finally {
        await client.end();
    }
}

// The kind of an address decides when the money may be credited. It is a
// property of the address, not of the deposit, so it never changes halfway
// through a deposit's life.
function classifyAddress(address, userId, purpose) {
    if (address === WITHDRAWAL_ADDR) return KIND_FLOAT;
    if (userId === FLOAT_USER_ID) return KIND_EXCHANGE;
    if (purpose && SYSTEM_PURPOSES.has(purpose)) return KIND_EXCHANGE;
    if (purpose === 'deposit') return KIND_BOT;
    return KIND_CUSTOMER;
}

// The kind of an address that is no longer in user_wallets: fall back to the
// customer flow, it is the only one that credits a customer.
function kindOf(address) {
    const w = WATCHED[address];
    return w ? w.kind : KIND_CUSTOMER;
}

function ownerOf(address) {
    const w = WATCHED[address];
    return w ? w.userId : null;
}

function findAddressInVout(vout) {
    const matches = [];
    for (const out of vout) {
        const addrs = out.scriptPubKey?.addresses || [];
        for (const addr of addrs) {
            if (WATCHED[addr] !== undefined) {
                matches.push({ n: out.n, value: out.value, address: addr, userId: WATCHED[addr].userId });
            }
        }
    }
    return matches;
}

// ---------------------------------------------------------------------------
// Internal transfers
// ---------------------------------------------------------------------------

// A deposit is INTERNAL when every input of the paying transaction belongs to
// the exchange itself (the node holds the key) and none of them is a customer
// or bot deposit address. No external money enters in that case: the coins
// only move between node-owned wallets (float -> change -> float, or
// float -> cold). Crediting such a transfer as a deposit inflates the float
// ledger, which is exactly how deposits 5 and 6 appeared on 2026-10-28, so
// they are journalled and marked, never credited.
//
// A sweep FROM a customer/bot deposit address is NOT internal: that is the
// collection of a real deposit, and the float must be credited for it (this is
// the normal path for deposits 2, 4, 8 and 10).
//
// Ownership must be asked from the node, not derived from WATCHED: change and
// staging addresses are node-owned but are not in user_wallets (only the named
// wallets are). getaddressinfo().ismine is the node's own answer.
const OWNERSHIP_TTL_MS = 10 * 60 * 1000;
const ownershipCache = new Map(); // address -> { mine, at }
const parentTxCache = new Map();  // txid -> tx

async function isNodeAddress(address) {
    const hit = ownershipCache.get(address);
    if (hit && Date.now() - hit.at < OWNERSHIP_TTL_MS) return hit.mine;
    let mine = false;
    try {
        const info = await rpcCallE('getaddressinfo', [address]);
        mine = !!(info && info.ismine);
    } catch (e) {
        // Unreadable address: treat it as external. A false negative only means
        // the deposit follows the old credit path; a false positive would
        // silently hide real customer money.
        mine = false;
    }
    if (ownershipCache.size > 5000) ownershipCache.clear();
    ownershipCache.set(address, { mine, at: Date.now() });
    return mine;
}

async function parentTx(txid) {
    if (parentTxCache.has(txid)) return parentTxCache.get(txid);
    let tx = null;
    try {
        tx = await rpcCallE('getrawtransaction', [txid, true]);
    } catch (e) {
        tx = null;
    }
    if (parentTxCache.size > 2000) parentTxCache.clear();
    parentTxCache.set(txid, tx);
    return tx;
}

// true = internal move between node-owned wallets. Coinbases, unresolvable
// prevouts and collections from customer/bot addresses all count as NOT
// internal (fail open: keep crediting).
async function isInternalTransfer(tx) {
    const vins = tx && Array.isArray(tx.vin) ? tx.vin : [];
    if (vins.length === 0) return false;
    for (const vin of vins) {
        if (!vin.txid) return false;
        const parent = await parentTx(vin.txid);
        const out = parent && Array.isArray(parent.vout) ? parent.vout[vin.vout] : null;
        if (!out) return false;
        const addrs = out.scriptPubKey?.addresses || [];
        if (addrs.length === 0) return false;
        let owned = false;
        for (const a of addrs) {
            const w = WATCHED[a];
            if (w && (w.kind === KIND_CUSTOMER || w.kind === KIND_BOT)) return false;
            if (await isNodeAddress(a)) owned = true;
        }
        if (!owned) return false;
    }
    return true;
}

function parseBlockTxids(hexStr) {
    const data = Buffer.from(hexStr, 'hex');
    if (data.length < 80) return [];
    const body = data.subarray(80);
    let offset = 0;

    const { value: count, bytesRead: countLen } = readVarInt(body, offset);
    offset += countLen;

    const txids = [];
    for (let i = 0; i < count; i++) {
        const txStart = offset;
        offset = skipTx(body, offset);
        const txBytes = body.subarray(txStart, offset);
        const h1 = crypto.createHash('sha256').update(txBytes).digest();
        const h2 = crypto.createHash('sha256').update(h1).digest();
        h2.reverse();
        txids.push(h2.toString('hex'));
    }
    return txids;
}

function readVarInt(buf, offset) {
    const b = buf[offset];
    if (b < 0xfd) return { value: b, bytesRead: 1 };
    if (b === 0xfd) return { value: buf.readUInt16LE(offset + 1), bytesRead: 3 };
    if (b === 0xfe) return { value: buf.readUInt32LE(offset + 1), bytesRead: 5 };
    return { value: Number(buf.readBigUInt64LE(offset + 1)), bytesRead: 9 };
}

function skipTx(buf, offset) {
    offset += 4;
    let segwit = false;
    if (buf[offset] === 0x00) { segwit = true; offset += 2; }
    let { value: inCount, bytesRead } = readVarInt(buf, offset); offset += bytesRead;
    for (let i = 0; i < inCount; i++) {
        offset += 36;
        const { value: sl, bytesRead: slb } = readVarInt(buf, offset); offset += slb + sl; offset += 4;
    }
    let { value: outCount, bytesRead: ol } = readVarInt(buf, offset); offset += ol;
    for (let i = 0; i < outCount; i++) {
        offset += 8;
        const { value: sl, bytesRead: slb } = readVarInt(buf, offset); offset += slb + sl;
    }
    if (segwit) {
        for (let i = 0; i < inCount; i++) {
            const { value: stackCount, bytesRead: scl } = readVarInt(buf, offset); offset += scl;
            for (let j = 0; j < stackCount; j++) {
                const { value: il, bytesRead: ilb } = readVarInt(buf, offset); offset += ilb + il;
            }
        }
    }
    offset += 4;
    return offset;
}

// ---------------------------------------------------------------------------
// Journaling
// ---------------------------------------------------------------------------

// Journal a deposit as PENDING. Nothing is credited here.
//
// A deposit only counts once it has been collected into the exchange float
// (#1) and that collect is final on chain: until then the exchange does not
// hold the coins, so the balance must not show them - the user would be able
// to spend money the float does not have. Both the wallet scanner (fast
// detector) and this monitor journal the same deposit; the hold row is the
// arbiter, so both can run without double-crediting anything.
async function journalDeposit(client, dep) {
    const amount = amountText(dep.value);
    const vout = Number.isInteger(dep.vout) ? dep.vout : 0;
    const internal = dep.internal === true;
    const hold = await client.query(
        `INSERT INTO lbtc_deposit_holds (user_id, address, amount, deposit_tx, vout, status, internal)
         VALUES ($1::int, $2, $3::numeric, $4, $5::int, 'held', $6::boolean)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [dep.userId, dep.address, amount, dep.txid, vout, internal]
    );
    // History row. 'processing' until the collect is final, so the user sees
    // the deposit as pending instead of as credited money.
    await client.query(
        `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address, fee, created_at, updated_at)
         VALUES ($1::int, $2::int, $3::numeric, 'processing', $4, $5, 0, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [dep.userId, LBTC_COIN_ID, amount, dep.txid, dep.address]
    );
    // Ledger row. 'pending' until the collect is final. An internal transfer is
    // marked here as well: the hold flag is what suppresses the credit.
    await client.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
         VALUES ($1::int, 'deposit', $2::numeric, $3, 'pending', 0, '', $4, NULL, $5, $6, 'lbtc', $7::jsonb, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [dep.userId, amount, CURRENCY,
            internal ? 'Internal LBTC transfer (not a deposit)' : 'On-chain LBTC deposit',
            dep.txid, dep.address,
            JSON.stringify(internal ? { internal: true, internal_kind: 'node_owned_transfer', marked_by: 'lbtc-deposit-monitor' } : {})]
    );
    return hold.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

// Confirmations of a transaction. Wallet transactions are answered by the
// wallet itself, everything else by the block it is mined in. 0 means "not
// final yet" (or unknown), which is exactly what the gates need.
async function txConfirmations(txid) {
    if (!txid) return 0;
    for (const wallet of SWEEP_WALLETS) {
        try {
            const t = await rpcCallE('gettransaction', [txid], wallet);
            if (t && typeof t.confirmations === 'number' && t.confirmations > 0) return t.confirmations;
        } catch (e) {}
    }
    try {
        const tx = await rpcCallE('getrawtransaction', [txid, true]);
        if (!tx) return 0;
        if (typeof tx.confirmations === 'number' && tx.confirmations > 0) return tx.confirmations;
        if (tx.blockhash) {
            const b = await rpcCallE('getblock', [tx.blockhash]);
            const tip = await rpcCallE('getblockcount');
            return tip - Number(b.height) + 1;
        }
        return 0;
    } catch (e) {
        return 0;
    }
}

// The transaction that collected the address' coins, if it was not collected
// by this monitor (a crashed cycle, or a manual sweep). The address index
// lists every transaction that touched the address, so the collect is the
// one that spends the deposit's output.
async function findCollectTx(address, depositTx) {
    let txs;
    try {
        txs = await rpcCallE('getaddresstxids', [address]);
    } catch (e) {
        return null;
    }
    if (!Array.isArray(txs)) return null;
    for (const txid of txs) {
        if (txid === depositTx) continue;
        let tx;
        try {
            tx = await rpcCallE('getrawtransaction', [txid, true]);
        } catch (e) {
            continue;
        }
        for (const vin of (tx.vin || [])) {
            if (vin.txid === depositTx) return txid;
        }
    }
    return null;
}

// Confirmed balance of an address (confirmed-only, wallet agnostic).
async function addressBalance(address) {
    try {
        const ab = await rpcCallE('getaddressbalance', [address]);
        return Number(ab && ab.balance) || 0;
    } catch (e) {
        return 0;
    }
}

// Sweep a customer's deposit address into the float. Failures are non-fatal:
// a missing or already-spent UTXO just means the address was already swept.
async function sweepAddressToFloat(address) {
    // Deposit addresses are spread across the `users` and legacy `bots` node
    // wallets; sweepallraw only sees inputs of the wallet named in the header,
    // so try the configured wallet first and the other deposit wallet second.
    for (const wallet of SWEEP_WALLETS) {
        try {
            const res = await rpcCallE('sweepallraw', [address, WITHDRAWAL_ADDR, SWEEP_FEE_BASE_UNITS], wallet);
            const txid = res && (res.txid || res.tx_id);
            if (txid) {
                log(`  -> SWEPT ${address} -> ${WITHDRAWAL_ADDR} via ${wallet} | tx: ${txid} | amount: ${res.amount || res.amount_base_units || ''}`);
                return txid;
            }
            return null;
        } catch (e) {
            if (!/no confirmed UTXOs|insufficient|Not enough available/i.test(String(e.message))) {
                log(`  -> sweep ${address} via ${wallet} failed: ${e.message}`);
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// The hold state machine
// ---------------------------------------------------------------------------

// Every held deposit, grouped by the address it was paid to. The address is
// the unit of collection: a sweep drains the whole address, so all deposits
// of one address share the collect.
async function loadHeldHolds() {
    const client = await connectDb();
    try {
        const res = await client.query(
            `SELECT id, user_id, address, amount, deposit_tx, vout, sweep_tx, status, balance_credited
               FROM lbtc_deposit_holds
              WHERE status = 'held'
              ORDER BY id`
        );
        const byAddress = new Map();
        for (const row of res.rows) {
            if (!byAddress.has(row.address)) byAddress.set(row.address, []);
            byAddress.get(row.address).push(row);
        }
        return byAddress;
    } finally {
        await client.end();
    }
}

// Release one hold: flip it to 'released' and move the money. The flip and
// the credit happen in one transaction and the flip is guarded by
// `status = 'held'`, so a hold can be released exactly once even if two
// monitor cycles overlap.
//
// balance_credited tells how the money reaches the ledger:
//   false - the deposit was never credited (the new flow). The release adds
//           the amount to `balance` and to `available`.
//   true  - the deposit was credited to `balance` when it was journalled (the
//           legacy flow). The release only moves it to `available`, so the
//           money is not counted twice.
//
// internal tells whether the paying transaction was funded entirely from
// node-owned wallets (not a customer/bot collection). Such a move brings no
// external money: when it lands on the float the release only flips the
// journal to completed and marks it, the balance is untouched. A customer or
// bot address is still credited normally.
async function releaseHold(hold, kind) {
    const client = await connectDb();
    try {
        await client.query('BEGIN');
        const flipped = await client.query(
            `UPDATE lbtc_deposit_holds
                SET status = 'released', released_at = NOW()
              WHERE id = $1::bigint AND status = 'held'
              RETURNING id, user_id, amount, address, deposit_tx, vout, status, balance_credited, internal`,
            [hold.id]
        );
        if (flipped.rowCount === 0) {
            await client.query('ROLLBACK');
            return false;
        }
        const h = flipped.rows[0];
        const amount = amountText(h.amount);
        const userId = Number(h.user_id);
        let internal = h.internal === true;
        // The wallet scanner journals the same deposits and cannot set this
        // flag, so a hold bound for the float or another exchange wallet is
        // confirmed from the chain before it is credited. One extra check per
        // such deposit is cheap; crediting an internal round-trip twice is not.
        if (!internal && (kind === KIND_FLOAT || kind === KIND_EXCHANGE)) {
            const depTx = await parentTx(h.deposit_tx);
            if (depTx) internal = await isInternalTransfer(depTx);
        }

        // The exchange's own non-float wallets are not customer money, and an
        // internal move into the float is not money entering at all: both are
        // journalled for the audit trail but never credited. A deposit into a
        // customer/bot address is always credited, even when the payer was the
        // exchange itself: the money lands on that account's balance.
        if (kind !== KIND_EXCHANGE && !(internal && kind === KIND_FLOAT)) {
            if (h.balance_credited === true) {
                await client.query(
                    `UPDATE balances SET available = available + $1::numeric, updated_at = NOW()
                      WHERE user_id = $2::int AND currency = $3`,
                    [amount, userId, CURRENCY]
                );
            } else {
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
        }

        // History and ledger rows follow the hold: 'processing'/'pending' until
        // the money is released, 'completed' after it.
        const dep = await client.query(
            `UPDATE deposits SET status = 'completed', updated_at = NOW()
              WHERE tx_hash = $1 AND coin_id = $2::int AND address = $3 AND amount = $4::numeric
              RETURNING id`,
            [h.deposit_tx, LBTC_COIN_ID, h.address, amount]
        );
        if (dep.rowCount === 0) {
            await client.query(
                `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address, fee, created_at, updated_at)
                 VALUES ($1::int, $2::int, $3::numeric, 'completed', $4, $5, 0, NOW(), NOW())
                 ON CONFLICT DO NOTHING`,
                [userId, LBTC_COIN_ID, amount, h.deposit_tx, h.address]
            );
        }
        const tx = await client.query(
            `UPDATE transactions SET status = 'completed', updated_at = NOW()
              WHERE tx_hash = $1 AND currency = $2 AND user_id = $3::int AND address = $4
                AND amount = $5::numeric AND type = 'deposit'
              RETURNING id`,
            [h.deposit_tx, CURRENCY, userId, h.address, amount]
        );
        if (tx.rowCount === 0) {
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
                 VALUES ($1::int, 'deposit', $2::numeric, $3, 'completed', 0, '', 'On-chain LBTC deposit', NULL, $4, $5, 'lbtc', '{}', NOW(), NOW())
                 ON CONFLICT DO NOTHING`,
                [userId, amount, CURRENCY, h.deposit_tx, h.address]
            );
        }

        // Keep the admin-visible journal honest: an internal transfer stays
        // marked as such when it completes, exactly like the manual marks on
        // deposits 5 and 6.
        if (internal) {
            if (h.internal !== true) {
                await client.query(
                    `UPDATE lbtc_deposit_holds SET internal = true WHERE id = $1::bigint`,
                    [h.id]
                );
            }
            await client.query(
                `UPDATE transactions
                    SET description = 'Internal LBTC transfer (not a deposit)',
                        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                            'internal', true,
                            'internal_kind', 'node_owned_transfer',
                            'marked_by', 'lbtc-deposit-monitor',
                            'marked_at', now()::text),
                        updated_at = NOW()
                  WHERE tx_hash = $1 AND currency = $2 AND user_id = $3::int
                    AND address = $4 AND amount = $5::numeric AND type = 'deposit'`,
                [h.deposit_tx, CURRENCY, userId, h.address, amount]
            );
        }

        // A customer's deposit address mirrors the customer's ledger: the API
        // falls back to user_wallets for the balance when the ledger read
        // fails, and the chain mirror of that address is 0 the moment the
        // coins are collected (which is what used to wipe users 57/58).
        if (kind === KIND_CUSTOMER) {
            const bal = await client.query(
                `SELECT balance, available FROM balances WHERE user_id = $1::int AND currency = $2`,
                [userId, CURRENCY]
            );
            if (bal.rows.length > 0) {
                await client.query(
                    `UPDATE user_wallets
                        SET balance = $1::numeric, available = $2::numeric, updated_at = NOW()
                      WHERE address = $3 AND currency = $4`,
                    [bal.rows[0].balance, bal.rows[0].available, h.address, CURRENCY]
                );
            }
        }

        await client.query('COMMIT');
        log(`  -> RELEASED ${amount} LBTC | user ${userId} | deposit ${h.deposit_tx.slice(0, 12)}... | kind ${kind}${internal ? ' | internal, not credited' : ''}`);
        return true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log(`  -> release failed for hold ${hold.id}: ${err.message}`);
        return false;
    } finally {
        await client.end();
    }
}

// A customer address: collect into the float first, credit after the collect
// is final.
async function processCustomerAddress(address, holds) {
    // The address is swept as a whole, but a deposit that is not confirmed yet
    // cannot be part of a collect: its UTXO is not spendable. Every hold is
    // therefore looked at on its own, and a sweep only covers the deposits
    // that are confirmed at the moment it happens.
    const confs = new Map();
    const confsFor = async (txid) => {
        if (!confs.has(txid)) confs.set(txid, await txConfirmations(txid));
        return confs.get(txid);
    };

    for (const h of holds) {
        if (h.sweep_tx) continue;
        const c = await confsFor(h.deposit_tx);
        if (c < DEPOSIT_CONFIRMATIONS) {
            log(`hold ${h.id}: deposit ${h.deposit_tx.slice(0, 12)}... has ${c}/${DEPOSIT_CONFIRMATIONS} confirmations, waiting`);
            continue;
        }
        const balance = await addressBalance(address);
        let collectTx = null;
        if (balance > 0) {
            collectTx = await sweepAddressToFloat(address);
            if (!collectTx) {
                log(`hold ${h.id}: ${address} holds ${balance} LBTC but could not be collected`);
                continue;
            }
        } else {
            // The address is empty: the coins were collected outside this
            // monitor (a crashed cycle or a manual sweep). Find the
            // transaction that spends this deposit, so it can still be gated
            // on the collect being final.
            collectTx = await findCollectTx(address, h.deposit_tx);
            if (!collectTx) {
                log(`hold ${h.id}: ${address} is empty but no collect of ${h.deposit_tx.slice(0, 12)}... was found, waiting`);
                continue;
            }
            log(`  -> ${address} already collected by ${collectTx.slice(0, 12)}... (adopted)`);
        }
        // A sweep drains every confirmed UTXO of the address, so it collects
        // every deposit of that address that is confirmed right now.
        const covered = [];
        for (const other of holds) {
            if (other.sweep_tx) continue;
            if (other.deposit_tx === h.deposit_tx) { covered.push(other); continue; }
            if (await confsFor(other.deposit_tx) >= DEPOSIT_CONFIRMATIONS) covered.push(other);
        }
        const ids = covered.map(o => o.id);
        if (ids.length === 0) continue;
        const client = await connectDb();
        try {
            await client.query(
                `UPDATE lbtc_deposit_holds SET sweep_tx = $1
                  WHERE id = ANY($2::bigint[]) AND status = 'held' AND sweep_tx IS NULL`,
                [collectTx, ids]
            );
        } finally {
            await client.end();
        }
        for (const o of covered) o.sweep_tx = collectTx;
    }

    const sweepTx = holds.find(h => h.sweep_tx)?.sweep_tx;
    if (!sweepTx) return;
    const collectConfs = await txConfirmations(sweepTx);
    if (collectConfs < COLLECT_CONFIRMATIONS) {
        log(`hold ${holds.filter(h => h.sweep_tx).map(h => h.id).join(',')}: collect ${sweepTx.slice(0, 12)}... has ${collectConfs}/${COLLECT_CONFIRMATIONS} confirmations, waiting`);
        return;
    }
    for (const h of holds) {
        if (!h.sweep_tx) continue;
        await releaseHold(h, KIND_CUSTOMER);
    }
}

// The float and the exchange's own wallets: the money is already where it
// belongs, so it is credited as soon as the deposit is confirmed.
async function processDirectAddress(address, holds) {
    const kind = kindOf(address);
    for (const h of holds) {
        const confs = await txConfirmations(h.deposit_tx);
        if (confs < DIRECT_CONFIRMATIONS) {
            log(`hold ${h.id}: deposit ${h.deposit_tx.slice(0, 12)}... has ${confs}/${DIRECT_CONFIRMATIONS} confirmations, waiting`);
            continue;
        }
        await releaseHold(h, kind);
    }
    // Bot deposit addresses hold the exchange's own coins: collect them into
    // the float so the float can spend them. The float ledger is credited
    // when the collect lands on the float address.
    if (kind === KIND_BOT) {
        const balance = await addressBalance(address);
        if (balance > 0) await sweepAddressToFloat(address);
    }
}

// One pass over every held deposit.
async function processHolds() {
    const byAddress = await loadHeldHolds();
    if (byAddress.size === 0) return;
    for (const [address, holds] of byAddress) {
        try {
            if (kindOf(address) === KIND_CUSTOMER) {
                await processCustomerAddress(address, holds);
            } else {
                await processDirectAddress(address, holds);
            }
        } catch (e) {
            log(`hold processing failed for ${address}: ${e.message}`);
        }
        await sleepMs();
    }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

async function scanBlock(height) {
    const hash = await rpcCallE('getblockhash', [height]);
    const block = await rpcCallE('getblock', [hash]);
    const txids = Array.isArray(block.tx) ? block.tx : [];
    if (txids.length === 0 && block.hex) {
        try { txids.push(...parseBlockTxids(block.hex)); } catch (e) {}
    }
    const deposits = [];
    for (const txid of txids) {
        try {
            const tx = await rpcCallE('getrawtransaction', [txid, true]);
            const matches = findAddressInVout(tx.vout || []);
            if (matches.length > 0) {
                // One ownership check per paying transaction, shared by all
                // outputs it pays to watched addresses.
                const internal = await isInternalTransfer(tx);
                for (const m of matches) {
                    deposits.push({
                        txid,
                        height,
                        value: m.value,
                        vout: m.n,
                        address: m.address,
                        userId: m.userId,
                        internal,
                        confirmations: tx.confirmations || 0,
                        time: tx.time,
                    });
                }
            }
        } catch (e) {}
        await sleepMs();
    }
    return deposits;
}

let cycleRunning = false;
async function checkDeposits() {
    if (cycleRunning) return;
    cycleRunning = true;
    try {
        // Never scan with a stale or empty address map: a failed reload would
        // silently drop deposits again.
        try {
            await loadWatched();
        } catch (e) {
            log(`watched-address reload failed: ${e.message}; cycle skipped`);
            return;
        }
        const tip = await rpcCallE('getblockcount');
        if (lastCheckedHeight === 0) {
            lastCheckedHeight = Math.max(0, tip - 100);
            saveState();
        }
        for (let h = lastCheckedHeight + 1; h <= tip; h++) {
            try {
                const found = await scanBlock(h);
                const client = await connectDb();
                try {
                    for (const dep of found) {
                        log(`DEPOSIT: ${amountText(dep.value)} LBTC | user ${dep.userId} | tx: ${dep.txid} | block: ${h} | vout ${dep.vout} | kind ${kindOf(dep.address)}`);
                        await journalDeposit(client, dep);
                    }
                } finally {
                    await client.end();
                }
            } catch (e) {
                log(`block ${h} scan error: ${e.message}; will retry next cycle`);
                saveState();
                throw new Error(`scan stopped at block ${h}`);
            }
            lastCheckedHeight = h;
            if (h % 25 === 0) {
                saveState();
                log(`scanned ->${h}/${tip}`);
            }
            await sleepMs();
        }
        saveState();

        await processHolds();

        try {
            await reconcileBotBalances();
        } catch (e) {
            log(`balance reconcile failed: ${e.message}`);
        }
        try {
            if (Date.now() - lastBalanceSyncAt >= BALANCE_SYNC_INTERVAL_MS) {
                lastBalanceSyncAt = Date.now();
                await syncWatchedBalances();
            }
        } catch (e) {
            log(`user_wallets sync failed: ${e.message}`);
        }
    } catch (err) {
        log(`Error: ${err.message}`);
    } finally {
        cycleRunning = false;
    }
}

// ---------------------------------------------------------------------------
// Ledger reconciliation
// ---------------------------------------------------------------------------

// The ledger credit above is additive: synthetic seeding, manual edits and
// missed updates drift `balances` away from the chain. For the bot accounts the
// wallet wins - force `balances` back onto it every cycle and recompute
// locked/available from open orders via fx_apply_locks.
async function reconcileBotBalances() {
    if (RECONCILE_USERS.length === 0) return;
    const client = await connectDb();
    try {
        const drift = await client.query(
            `WITH w AS (
                 SELECT DISTINCT ON (user_id) user_id, balance
                   FROM user_wallets
                  WHERE user_id = ANY($1::int[]) AND currency = $2
                    AND network IN ($2, 'main')
                    AND status = 'active' AND is_valid = true
                    AND address IS NOT NULL AND address <> ''
                    AND balance IS NOT NULL
                  ORDER BY user_id, (purpose IS NULL OR purpose = '') DESC, id DESC
             )
             SELECT b.user_id, b.balance AS old_balance, w.balance AS new_balance
               FROM balances b
               JOIN w ON w.user_id = b.user_id
              WHERE b.currency = $2 AND b.balance IS DISTINCT FROM w.balance
              ORDER BY b.user_id`,
            [RECONCILE_USERS, CURRENCY]
        );
        if (drift.rows.length === 0) return;
        const ids = drift.rows.map(r => Number(r.user_id));
        await client.query(
            `WITH w AS (
                 SELECT DISTINCT ON (user_id) user_id, balance
                   FROM user_wallets
                  WHERE user_id = ANY($1::int[]) AND currency = $2
                    AND network IN ($2, 'main')
                    AND status = 'active' AND is_valid = true
                    AND address IS NOT NULL AND address <> ''
                    AND balance IS NOT NULL
                  ORDER BY user_id, (purpose IS NULL OR purpose = '') DESC, id DESC
             )
             UPDATE balances b SET balance = w.balance, updated_at = NOW()
               FROM w
              WHERE b.user_id = w.user_id AND b.currency = $2`,
            [ids, CURRENCY]
        );
        for (const id of ids) {
            await client.query('SELECT fx_apply_locks($1::int)', [id]);
        }
        for (const r of drift.rows) {
            log(`RECONCILE: user ${r.user_id} ${CURRENCY} balance ${Number(r.old_balance)} -> ${Number(r.new_balance)}`);
        }
    } finally {
        await client.end();
    }
}

// Withdrawals debit the node float and the node scatters change onto fresh
// wallet addresses, so the deposit address of record (user_wallets) gets spent
// to zero without the ledger noticing. Keep user_wallets.balance a mirror of
// that ONE address's on-chain balance, refreshed from getaddressbalance (which
// is wallet-agnostic: it answers for any address, spendable or not). Bot
// accounts (RECONCILE_USERS) carry seeded balances on placeholder addresses,
// not chain money - never sync those. A failure for one address (e.g. a
// non-chain placeholder) is treated as 0 so the stale stamp cannot survive.
//
// System wallets (the named hot/cold/withdrawal/fee/... set on user 1) are the
// float: their on-chain balance IS the source of truth and must be mirrored.
// A real user's deposit address, however, is collected into that float right
// after the deposit is credited, so its on-chain balance is legitimately 0
// while the user's money lives in `balances`. Mirroring the chain there would
// zero a real liability (this is exactly how users 57/58 kept getting wiped).
// Those rows are therefore excluded and left to follow the ledger: they are
// the rows without a `purpose` (system wallets all carry one).
async function syncWatchedBalances() {
    const client = await connectDb();
    try {
        const res = await client.query(
            `SELECT w.id, w.user_id, w.address FROM user_wallets w
              WHERE w.currency = $1 AND w.network IN ($1, 'main')
                AND w.status = 'active' AND w.is_valid = true
                AND w.address IS NOT NULL AND w.address <> ''
                AND NOT (w.user_id = ANY($2::int[]))
                AND NOT (w.purpose IS NULL OR w.purpose = '')`,
            [CURRENCY, RECONCILE_USERS]
        );
        let changed = 0, failed = 0;
        for (const r of res.rows) {
            let bal = 0;
            try {
                const ab = await rpcCallE('getaddressbalance', [r.address]);
                const n = Number(ab && ab.balance);
                if (Number.isFinite(n) && n > 0) bal = n;
            } catch (e) {
                failed++;
            }
            const u = await client.query(
                `UPDATE user_wallets
                    SET balance = $1::numeric, available = $1::numeric, updated_at = NOW()
                  WHERE id = $2::int AND currency = $3
                    AND (balance IS DISTINCT FROM $1::numeric OR available IS DISTINCT FROM $1::numeric)`,
                [bal, r.id, CURRENCY]
            );
            if (u.rowCount > 0) changed++;
            await sleepMs();
        }
        log(`sync user_wallets on-chain: ${changed}/${res.rows.length} changed (${failed} unreadable)`);
    } finally {
        await client.end();
    }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Self-contained schema for the hold ledger (no external migrations).
//
// `vout` identifies the deposit output inside its transaction: one tx can pay
// the same address twice (the chain has both: tx b25e8dc7 pays LSUsrwZW...
// 151.9995 and 0.0001), so the transaction alone does not identify a deposit.
//
// `balance_credited` separates the two eras of the ledger: rows created before
// this migration were credited to `balances.balance` when they were
// journalled, rows created now are credited when they are released. The
// backfill that marks the old rows runs exactly once, guarded by a marker row,
// so a monitor restart can never mark a fresh deposit as already credited.
//
// `internal` records that the paying transaction was funded entirely from
// node-owned addresses. Those are internal moves (float round-trips, cold
// consolidations), journalled but never credited.
async function ensureSchema() {
    const client = await connectDb();
    try {
        await client.query(
            `CREATE TABLE IF NOT EXISTS lbtc_deposit_holds (
                 id bigserial PRIMARY KEY,
                 user_id integer NOT NULL,
                 address varchar NOT NULL,
                 amount numeric(32,16) NOT NULL,
                 deposit_tx varchar NOT NULL,
                 vout integer NOT NULL DEFAULT 0,
                 sweep_tx varchar,
                 status varchar NOT NULL DEFAULT 'held',
                 balance_credited boolean NOT NULL DEFAULT false,
                 internal boolean NOT NULL DEFAULT false,
                 created_at timestamptz NOT NULL DEFAULT now(),
                 released_at timestamptz
             )`);
        await client.query(
            `ALTER TABLE lbtc_deposit_holds ADD COLUMN IF NOT EXISTS vout integer NOT NULL DEFAULT 0`);
        await client.query(
            `ALTER TABLE lbtc_deposit_holds ADD COLUMN IF NOT EXISTS balance_credited boolean NOT NULL DEFAULT false`);
        await client.query(
            `ALTER TABLE lbtc_deposit_holds ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT false`);
        await client.query(
            `CREATE INDEX IF NOT EXISTS lbtc_deposit_holds_held_idx
                 ON lbtc_deposit_holds (address) WHERE status = 'held'`);

        // One deposit per (transaction, output). The old constraint
        // (deposit_tx, address) cannot tell two outputs of the same
        // transaction apart.
        await client.query(`ALTER TABLE lbtc_deposit_holds DROP CONSTRAINT IF EXISTS lbtc_deposit_holds_deposit_uniq`);
        await client.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS lbtc_deposit_holds_deposit_uniq
                 ON lbtc_deposit_holds (deposit_tx, address, vout)`);

        // One-time marker: the legacy rows were credited when they were
        // journalled, the new ones are credited when they are released. The
        // marker and the backfill share a transaction, so a crash in between
        // cannot leave the marker set with the rows unmarked.
        await client.query(
            `CREATE TABLE IF NOT EXISTS lbtc_ops_migrations (
                 name text PRIMARY KEY,
                 applied_at timestamptz NOT NULL DEFAULT now()
             )`);
        await client.query('BEGIN');
        try {
            const marker = await client.query(
                `INSERT INTO lbtc_ops_migrations (name) VALUES ('lbtc_holds_balance_credited_backfill')
                  ON CONFLICT (name) DO NOTHING RETURNING name`);
            if (marker.rowCount === 1) {
                const backfilled = await client.query(
                    `UPDATE lbtc_deposit_holds SET balance_credited = true WHERE balance_credited = false`);
                log(`legacy holds marked as already credited: ${backfilled.rowCount}`);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        }

        // A deposit is one transaction output; the history and the ledger must
        // not hold it twice. The unique indexes make the journal idempotent
        // even if the scanner and the monitor both see the same deposit.
        try {
            await client.query(
                `CREATE UNIQUE INDEX IF NOT EXISTS deposits_tx_uniq
                     ON deposits (tx_hash, coin_id, address, amount)`);
        } catch (e) {
            log(`deposits unique index not created: ${e.message}`);
        }
        try {
            await client.query(
                `CREATE UNIQUE INDEX IF NOT EXISTS transactions_deposit_tx_uniq
                     ON transactions (tx_hash, currency, user_id, address, amount)
                    WHERE type = 'deposit'`);
        } catch (e) {
            log(`transactions unique index not created: ${e.message}`);
        }
    } finally {
        await client.end();
    }
}

// Operator helper: classify a transaction without touching the monitor state.
// `node server/scripts/check-lbtc-deposits.js --classify-tx <txid>`
const classifyIdx = process.argv.indexOf('--classify-tx');
if (classifyIdx !== -1) {
    const txid = process.argv[classifyIdx + 1];
    (async () => {
        if (!txid) throw new Error('usage: --classify-tx <txid>');
        await loadWatched();
        const tx = await rpcCallE('getrawtransaction', [txid, true]);
        const internal = await isInternalTransfer(tx);
        const inputs = [];
        for (const vin of tx.vin || []) {
            if (!vin.txid) { inputs.push({ coinbase: true }); continue; }
            const parent = await parentTx(vin.txid);
            const out = parent && parent.vout ? parent.vout[vin.vout] : null;
            for (const a of (out?.scriptPubKey?.addresses || [])) {
                inputs.push({ address: a, value: out.value, ismine: await isNodeAddress(a), watched_kind: WATCHED[a]?.kind || null });
            }
        }
        const outputs = [];
        for (const o of tx.vout || []) {
            for (const a of o.scriptPubKey?.addresses || []) {
                outputs.push({ address: a, value: o.value, ismine: await isNodeAddress(a), watched_kind: WATCHED[a]?.kind || null });
            }
        }
        console.log(JSON.stringify({ txid, internal, inputs, outputs }, null, 2));
        process.exit(0);
    })().catch((e) => {
        console.error(`classify failed: ${e.message}`);
        process.exit(1);
    });
} else {
    console.log(`LBTC monitor started. Addresses are loaded from user_wallets (currency=${CURRENCY})`);
    console.log(`Database candidates: ${dbCandidates().map(c => `${c.host}:${c.port}`).join(', ')}`);
    console.log(`Gates: deposit=${DEPOSIT_CONFIRMATIONS} confs, collect=${COLLECT_CONFIRMATIONS} confs, direct=${DIRECT_CONFIRMATIONS} confs`);
    loadState();
    if (lastCheckedHeight > 0) console.log(`Resume from block ${lastCheckedHeight}`);

    const isSyncNow = process.argv.includes('--sync-now');
    if (isSyncNow) {
        (async () => {
            await ensureSchema();
            await loadWatched();
            await syncWatchedBalances();
            console.log('sync-now complete');
        })().catch((e) => {
            console.error(`sync-now failed: ${e.message}`);
            process.exit(1);
        });
    } else {
        ensureSchema()
            .then(() => checkDeposits())
            .catch((e) => console.error(`schema init failed: ${e.message}`));
        setInterval(checkDeposits, 30 * 1000);
    }
}
