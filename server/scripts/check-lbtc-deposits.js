'use strict';

const http = require('http');
const crypto = require('crypto');

const RPC_USER = 'coin';
const RPC_PASS = 'coin';
const RPC_HOST = '127.0.0.1';
const RPC_PORT = 19556;
const CURRENCY = 'lbtc';
const MIN_CONFIRMATIONS = 3;

// Watched addresses -> user_id mapping
const WATCHED = {
    'LRjqhn8LYZS7bHoBbyeBnHvHojA9o3ackH': 58,  // user 58 deposit
    'LSUsrwZW6qHiwYqU5TgApzprSwY2EbgtAK': 1,   // exchange hot wallet
};

let lastCheckedHeight = 0;
const pendingDeposits = new Map(); // txid -> deposit info

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

async function getBlockHash(height) {
    return rpcCall('getblockhash', [height]);
}

async function getBlock(hash) {
    return rpcCall('getblock', [hash]);
}

async function getRawTransaction(txid) {
    return rpcCall('getrawtransaction', [txid, true]);
}

async function getBlockCount() {
    return rpcCall('getblockcount');
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
    const hash = await getBlockHash(height);
    const block = await getBlock(hash);
    const txids = Array.isArray(block.tx) ? block.tx : [];
    if (txids.length === 0 && block.hex) {
        try { txids.push(...parseBlockTxids(block.hex)); } catch (e) {}
    }
    const deposits = [];
    for (const txid of txids) {
        try {
            const tx = await getRawTransaction(txid);
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
    }
    return deposits;
}

async function checkDeposits() {
    try {
        const tip = await getBlockCount();
        if (lastCheckedHeight === 0) lastCheckedHeight = tip - 100;
        const newDeposits = [];
        for (let h = lastCheckedHeight + 1; h <= tip; h++) {
            newDeposits.push(...await scanBlock(h));
        }
        lastCheckedHeight = tip;

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
                    const tx = await getRawTransaction(txid);
                    const confs = tx.confirmations || 0;
                    if (confs >= MIN_CONFIRMATIONS) {
                        console.log(`[${new Date().toISOString()}] CONFIRMED: ${dep.value} LBTC | tx: ${txid} | confs: ${confs}`);
                        pendingDeposits.delete(txid);
                        await creditBalance({ ...dep, confirmations: confs });
                    }
                } catch (e) {}
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
    const client = new Client({ host: '127.0.0.1', port: 5454, database: 'hollaex', user: 'admin', password: 'root' });
    try {
        await client.connect();
        const existing = await client.query('SELECT id FROM transactions WHERE tx_hash = $1', [deposit.txid]);
        if (existing.rows.length > 0) return;

        const value = Number(deposit.value);
        const userId = Number(deposit.userId);

        await client.query(
            'UPDATE balances SET balance = balance + $1::numeric, available = available + $1::numeric, updated_at = NOW() WHERE user_id = $2::int AND currency = $3',
            [value, userId, CURRENCY]
        );
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
             VALUES ($1::int, 'deposit', $2::numeric, $3, 'completed', 0, '', 'On-chain LBTC deposit', NULL, $4, $5, 'lbtc', '{}', NOW(), NOW())`,
            [userId, value, CURRENCY, deposit.txid, deposit.address]
        );
        // Sync user_wallets
        await client.query(
            `INSERT INTO user_wallets (user_id, currency, balance, available, address, network, is_valid, created_at, updated_at)
             VALUES ($1::int, $2, $3::numeric, $3::numeric, $4, 'lbtc', true, NOW(), NOW())
             ON CONFLICT (user_id, currency) DO UPDATE SET balance = (SELECT balance FROM balances WHERE user_id = $1::int AND currency = $2), available = (SELECT available FROM balances WHERE user_id = $1::int AND currency = $2), address = $4, updated_at = NOW()`,
            [userId, CURRENCY, value, deposit.address]
        );
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

checkDeposits();
setInterval(checkDeposits, 30 * 1000);
