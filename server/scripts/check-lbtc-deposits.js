'use strict';

const http = require('http');
const crypto = require('crypto');

const RPC_USER = 'coin';
const RPC_PASS = 'coin';
const RPC_HOST = '127.0.0.1';
const RPC_PORT = 19556;
const CURRENCY = 'lbtc';
const MIN_CONFIRMATIONS = 3;
const RPC_DELAY_MS = 350;

// Watched addresses -> user_id mapping
const WATCHED = {
    'LRjqhn8LYZS7bHoBbyeBnHvHojA9o3ackH': 58,  // user 58 deposit
    'LSUsrwZW6qHiwYqU5TgApzprSwY2EbgtAK': 1,   // exchange hot wallet
};

let lastCheckedHeight = 0;
const pendingDeposits = new Map(); // txid -> deposit info

const STATE_FILE = __dirname + '/lbtc-monitor-state.json';

function loadState() {
    try {
        lastCheckedHeight = JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8')).lastCheckedHeight || 0;
    } catch (e) {
        lastCheckedHeight = 0;
    }
}

function saveState() {
    try {
        require('fs').writeFileSync(STATE_FILE, JSON.stringify({ lastCheckedHeight }, null, 2));
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
            hostname: RPC_HOST,
            port: RPC_PORT,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64'),
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

async function checkDeposits() {
    try {
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
        }

        if (newDeposits.length === 0 && pendingDeposits.size === 0) {
            console.log(`[${new Date().toISOString()}] OK. Tip: ${tip}`);
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error:`, err.message);
    }
}

async function creditBalance(deposit) {
    const { Client } = require('pg');
    const client = new Client({ host: '172.18.0.4', port: 5432, database: 'hollaex', user: 'admin', password: 'root' });
    try {
        await client.connect();
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
        // Sync user_wallets: update first, insert only if no row exists
        const uw = await client.query(
            `UPDATE user_wallets SET balance = $1::numeric, available = $1::numeric, address = $2, updated_at = NOW()
             WHERE user_id = $3::int AND currency = $4 AND (purpose IS NULL OR purpose = '')`,
            [value, deposit.address, userId, CURRENCY]
        );
        if (uw.rowCount === 0) {
            await client.query(
                `INSERT INTO user_wallets (user_id, currency, balance, available, address, network, is_valid, created_at, updated_at)
                 VALUES ($1::int, $2, $3::numeric, $3::numeric, $4, 'lbtc', true, NOW(), NOW())`,
                [userId, CURRENCY, value, deposit.address]
            );
        }
        console.log(`  -> Credited ${value} LBTC to user ${userId}`);
    } catch (err) {
        console.error('  -> Credit error:', err.message);
    } finally {
        await client.end();
    }
}

console.log(`LBTC monitor started. Watching ${Object.keys(WATCHED).length} addresses`);
console.log(`  user 58: LRjqhn8LYZS7bHoBbyeBnHvHojA9o3ackH`);
console.log(`  hot wallet (user 1): LSUsrwZW6qHiwYqU5TgApzprSwY2EbgtAK`);
console.log(`Min confirmations: ${MIN_CONFIRMATIONS}`);
loadState();
if (lastCheckedHeight > 0) console.log(`Resume from block ${lastCheckedHeight}`);

checkDeposits();
setInterval(checkDeposits, 30 * 1000);
