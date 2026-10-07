'use strict';

const http = require('http');
const { rpcConfig, dbConfig } = require('./lbtc-ops-env');
const crypto = require('crypto');

const CURRENCY = 'lbtc';
const MIN_CONFIRMATIONS = 3;
const RPC_DELAY_MS = 350;
const RECONCILE_USERS = (process.env.LBTC_RECONCILE_USERS || '100,101,102,103,104,105,106,107,108,109')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);

// Watched addresses -> user_id mapping. Reloaded from user_wallets on every
// cycle, so per-user deposit addresses are picked up without a code change.
let WATCHED = {};
let lastWatchedSig = '';

let lastCheckedHeight = 0;
const pendingDeposits = new Map(); // txid -> deposit info

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
        if (Array.isArray(saved.pendingDeposits)) {
            for (const [txid, dep] of saved.pendingDeposits) pendingDeposits.set(txid, dep);
        }
    } catch (e) {
        lastCheckedHeight = 0;
    }
}

function saveState() {
    try {
        require('fs').writeFileSync(STATE_FILE, JSON.stringify({
            lastCheckedHeight,
            pendingDeposits: [...pendingDeposits.entries()],
        }, null, 2));
    } catch (e) {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sleepMs = async () => {
    await sleep(RPC_DELAY_MS);
};

function rpcCall(method, params = []) {
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
async function rpcCallE(method, params = []) {
    for (let attempt = 0; attempt < 8; attempt++) {
        if (attempt > 0) await sleep(RPC_DELAY_MS * attempt);
        try {
            const v = await rpcCall(method, params);
            return v;
        } catch (e) {
            const is429 = /too many requests/i.test(String(e.message));
            if (!is429) throw e;
        }
    }
    throw new Error(`${method} still rate-limited after retries`);
}

// Deposit addresses -> user_id, straight from the exchange DB. Rows without a
// purpose (exchange wallets) win over per-user rows when an address is shared,
// so the hot wallet keeps crediting the account it always credited.
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
                dupes.push(`${row.address} -> user ${row.user_id} ignored, user ${next[row.address]} kept`);
                continue;
            }
            next[row.address] = Number(row.user_id);
        }
        const sig = JSON.stringify(next);
        if (sig !== lastWatchedSig) {
            console.log(`[${new Date().toISOString()}] watched addresses: ${Object.keys(WATCHED).length} -> ${Object.keys(next).length}`);
            for (const d of dupes) console.log(`[${new Date().toISOString()}] shared address: ${d}`);
            lastWatchedSig = sig;
        }
        WATCHED = next;
        return Object.keys(next).length;
    } finally {
        await client.end();
    }
}

function findAddressInVout(vout) {
    const matches = [];
    for (const out of vout) {
        const addrs = out.scriptPubKey?.addresses || [];
        for (const addr of addrs) {
            if (WATCHED[addr] !== undefined) {
                matches.push({ n: out.n, value: out.value, address: addr, userId: WATCHED[addr] });
            }
        }
    }
    return matches;
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
            let { value: stackCount, bytesRead: scl } = readVarInt(buf, offset); offset += scl;
            for (let j = 0; j < stackCount; j++) {
                const { value: il, bytesRead: ilb } = readVarInt(buf, offset); offset += ilb + il;
            }
        }
    }
    offset += 4;
    return offset;
}

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
            for (const m of matches) {
                deposits.push({
                    txid,
                    height,
                    value: m.value,
                    address: m.address,
                    userId: m.userId,
                    confirmations: tx.confirmations || 0,
                    time: tx.time,
                });
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
            console.error(`[${new Date().toISOString()}] watched-address reload failed: ${e.message}; cycle skipped`);
            return;
        }
        const tip = await rpcCallE('getblockcount');
        if (lastCheckedHeight === 0) {
            lastCheckedHeight = Math.max(0, tip - 100);
            saveState();
        }
        const newDeposits = [];
        for (let h = lastCheckedHeight + 1; h <= tip; h++) {
            try {
                const found = await scanBlock(h);
                newDeposits.push(...found);
            } catch (e) {
                console.error(`[${new Date().toISOString()}] block ${h} scan error: ${e.message}; will retry next cycle`);
                saveState();
                throw new Error(`scan stopped at block ${h}`);
            }
            lastCheckedHeight = h;
            if (h % 25 === 0) {
                saveState();
                console.log(`[${new Date().toISOString()}] scanned →${h}/${tip}`);
            }
            await sleepMs();
        }
        saveState();

        for (const dep of newDeposits) {
            const confirmed = dep.confirmations >= MIN_CONFIRMATIONS;
            console.log(`[${new Date().toISOString()}] DEPOSIT: ${dep.value} LBTC | user ${dep.userId} | tx: ${dep.txid} | block: ${dep.height} | confs: ${dep.confirmations} | ${confirmed ? 'CONFIRMED' : 'PENDING'}`);
            if (confirmed) {
                pendingDeposits.delete(dep.txid);
                await creditBalance(dep);
            } else {
                pendingDeposits.set(dep.txid, dep);
            }
        }
        if (newDeposits.length > 0) saveState();

        if (pendingDeposits.size > 0) {
            for (const [txid, dep] of pendingDeposits) {
                try {
                    const tx = await rpcCallE('getrawtransaction', [txid, true]);
                    const confs = tx.confirmations || 0;
                    if (confs >= MIN_CONFIRMATIONS) {
                        console.log(`[${new Date().toISOString()}] CONFIRMED: ${dep.value} LBTC | tx: ${txid} | confs: ${confs}`);
                        pendingDeposits.delete(txid);
                        await creditBalance({ ...dep, confirmations: confs });
                    }
                } catch (e) {}
                await sleepMs();
            }
            saveState();
        }

        if (newDeposits.length === 0 && pendingDeposits.size === 0) {
            console.log(`[${new Date().toISOString()}] OK. Tip: ${tip}`);
        }
        try {
            await reconcileBotBalances();
        } catch (e) {
            console.error(`[${new Date().toISOString()}] balance reconcile failed: ${e.message}`);
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error:`, err.message);
    } finally {
        cycleRunning = false;
    }
}

async function creditBalance(deposit) {
    const client = await connectDb();
    try {
        const existing = await client.query('SELECT id FROM transactions WHERE tx_hash = $1', [deposit.txid]);
        if (existing.rows.length > 0) return;

        const value = Number(deposit.value);
        const userId = Number(deposit.userId);

        const bal = await client.query(
            'UPDATE balances SET balance = balance + $1::numeric, available = available + $1::numeric, updated_at = NOW() WHERE user_id = $2::int AND currency = $3',
            [value, userId, CURRENCY]
        );
        if (bal.rowCount === 0) {
            await client.query(
                `INSERT INTO balances (user_id, currency, balance, available, locked, updated_at)
                 VALUES ($1::int, $2, $3::numeric, $3::numeric, 0, NOW())`,
                [userId, CURRENCY, value]
            );
        }
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
             VALUES ($1::int, 'deposit', $2::numeric, $3, 'completed', 0, '', 'On-chain LBTC deposit', NULL, $4, $5, 'lbtc', '{}', NOW(), NOW())`,
            [userId, value, CURRENCY, deposit.txid, deposit.address]
        );
        // Sync the deposit address itself. Matched by address, not by
        // (user, currency): a user can now have several lbtc addresses, and the
        // old lookup missed purpose='deposit' rows and inserted a duplicate.
        let addrBalance = value;
        try {
            const ab = await rpcCallE('getaddressbalance', [deposit.address]);
            addrBalance = Number(ab.balance) || value;
        } catch (e) {}
        const uw = await client.query(
            `UPDATE user_wallets SET balance = $1::numeric, available = $1::numeric, updated_at = NOW()
             WHERE address = $2 AND currency = $3`,
            [addrBalance, deposit.address, CURRENCY]
        );
        if (uw.rowCount === 0) {
            await client.query(
                `INSERT INTO user_wallets (user_id, currency, balance, available, address, network, is_valid, purpose, status, created_at, updated_at)
                 VALUES ($1::int, $2, $3::numeric, $3::numeric, $4, 'lbtc', true, 'deposit', 'active', NOW(), NOW())`,
                [userId, CURRENCY, addrBalance, deposit.address]
            );
        }
        console.log(`  -> Credited ${value} LBTC to user ${userId}`);
    } catch (err) {
        console.error('  -> Credit error:', err.message);
    } finally {
        await client.end();
    }
}

// The ledger credit above is additive: synthetic seeding, manual edits and
// missed updates drift `balances` away from the chain. For the bot accounts the
// wallet wins — force `balances` back onto it every cycle and recompute
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
            console.log(`[${new Date().toISOString()}] RECONCILE: user ${r.user_id} ${CURRENCY} balance ${Number(r.old_balance)} -> ${Number(r.new_balance)}`);
        }
    } finally {
        await client.end();
    }
}

console.log(`LBTC monitor started. Addresses are loaded from user_wallets (currency=${CURRENCY})`);
console.log(`Database candidates: ${dbCandidates().map(c => `${c.host}:${c.port}`).join(', ')}`);
console.log(`Min confirmations: ${MIN_CONFIRMATIONS}`);
loadState();
if (lastCheckedHeight > 0) console.log(`Resume from block ${lastCheckedHeight}`);

checkDeposits();
setInterval(checkDeposits, 30 * 1000);
