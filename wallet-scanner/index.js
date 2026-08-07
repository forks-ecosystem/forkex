'use strict';

const bitcoin = require('bitcoinjs-lib');
const { Pool } = require('pg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RPC_PORT = 19556;
const RPC_HOST = '127.0.0.1';
const CLI_PATH = '/root/LegacyCore/legacycoin-cli';

const DB_CONFIG = {
    host: '127.0.0.1',
    port: 5454,
    user: 'admin',
    password: 'root',
    database: 'hollaex',
};

const SCAN_INTERVAL_MS = 15000;
const STATE_FILE = path.join(__dirname, 'scanner-state.json');

let knownAddresses = [];
let lastScannedHeight = 0;

function rpcCall(method) {
    const args = [];
    for (let i = 1; i < arguments.length; i++) {
        args.push(typeof arguments[i] === 'string' ? `"${arguments[i]}"` : String(arguments[i]));
    }
    const cmd = `${CLI_PATH} -rpcport=${RPC_PORT} -rpcuser=coin -rpcpassword=coin ${method} ${args.join(' ')} 2>&1`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    const parsed = JSON.parse(out);
    if (parsed.error) throw new Error(`RPC ${method}: ${parsed.error.message}`);
    return parsed.result;
}

function loadState() {
    try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        lastScannedHeight = data.lastScannedHeight || 0;
    } catch (e) {
        lastScannedHeight = 0;
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastScannedHeight }, null, 2));
}

const pool = new Pool(DB_CONFIG);

async function loadKnownAddresses() {
    const res = await pool.query(
        `SELECT uw.user_id, uw.address, uw.currency
         FROM user_wallets uw
         WHERE uw.currency = 'lbtc'`
    );
    knownAddresses = [];
    for (const row of res.rows) {
        try {
            const info = rpcCall('validateaddress', row.address);
            if (info && info.isvalid && info.pubkey_hash_hex) {
                knownAddresses.push({
                    user_id: row.user_id,
                    address: row.address,
                    pubkey_hash: info.pubkey_hash_hex,
                });
            }
        } catch (e) {
            console.error(`[Scanner] Failed to validate ${row.address}: ${e.message}`);
        }
    }
    console.log(`[Scanner] Loaded ${knownAddresses.length} known addresses`);
    for (const a of knownAddresses) {
        console.log(`[Scanner]  user=${a.user_id} addr=${a.address.slice(0,16)}... hash=${a.pubkey_hash.slice(0,16)}...`);
    }
}

function extractPubkeyHash(scriptBuffer) {
    const hex = scriptBuffer.toString('hex');
    if (hex.startsWith('76a914') && hex.endsWith('88ac') && hex.length === 50) {
        return hex.slice(6, 46);
    }
    if (hex.startsWith('a914') && hex.endsWith('87') && hex.length === 46) {
        return hex.slice(4, 44);
    }
    if (hex.startsWith('0014') && hex.length === 44) {
        return hex.slice(4, 44);
    }
    return null;
}

async function depositExists(txHash) {
    const res = await pool.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
    return res.rows.length > 0;
}

async function createDeposit(userId, coinId, amount, txHash, address) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address)
             VALUES ($1, $2, $3, 'completed', $4, $5)`,
            [userId, coinId, amount, txHash, address]
        );
        await client.query(
            `UPDATE balances SET balance = balance + $1, available = available + $1, updated_at = NOW()
             WHERE user_id = $2 AND currency = 'lbtc'`,
            [amount, userId]
        );
        await client.query(
            `UPDATE user_wallets SET balance = balance + $1, available = available + $1, updated_at = NOW()
             WHERE user_id = $2 AND currency = 'lbtc'`,
            [amount, userId]
        );
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, description, tx_hash, address, network)
             VALUES ($1, 'deposit', $2, 'lbtc', 'completed', 'LBTC deposit detected by wallet scanner', $3, $4, 'lbtc')`,
            [userId, amount, txHash, address]
        );
        await client.query('COMMIT');
        console.log(`[Scanner] Deposit: user=${userId} ${amount} LBTC tx=${txHash.slice(0,20)}...`);
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function scanBlock(height) {
    const hash = rpcCall('getblockhash', height);
    const blockData = rpcCall('getblock', hash);
    const block = bitcoin.Block.fromHex(blockData.hex);
    let depositsFound = 0;

    for (const tx of block.transactions) {
        const txid = tx.getId();

        if (tx.ins[0] && tx.ins[0].hash && tx.ins[0].hash.equals(Buffer.alloc(32))) {
            continue;
        }
        if (await depositExists(txid)) continue;

        for (const out of tx.outs) {
            const valueLbtc = Number(out.value) / 100000000;
            if (valueLbtc <= 0) continue;

            const pubkeyHash = extractPubkeyHash(out.script);
            if (!pubkeyHash) continue;

            const user = knownAddresses.find(a => a.pubkey_hash === pubkeyHash);
            if (!user) continue;

            try {
                await createDeposit(user.user_id, 23, valueLbtc, txid, user.address);
                depositsFound++;
            } catch (e) {
                console.error(`[Scanner] Deposit failed tx=${txid.slice(0,20)}...: ${e.message}`);
            }
        }
    }
    return depositsFound;
}

async function scanLoop() {
    try {
        const currentHeight = rpcCall('getblockcount');
        if (lastScannedHeight <= 0) {
            lastScannedHeight = currentHeight;
            saveState();
            console.log(`[Scanner] Initialized at block ${currentHeight}`);
            return;
        }
        if (currentHeight <= lastScannedHeight) return;

        console.log(`[Scanner] Scanning ${lastScannedHeight + 1} → ${currentHeight}`);
        for (let h = lastScannedHeight + 1; h <= currentHeight; h++) {
            const found = await scanBlock(h);
            if (found > 0) console.log(`[Scanner] Block ${h}: ${found} deposit(s)`);
        }
        lastScannedHeight = currentHeight;
        saveState();
    } catch (e) {
        console.error(`[Scanner] Error: ${e.message}`);
    }
}

async function main() {
    loadState();
    await loadKnownAddresses();
    console.log(`[Scanner] Starting (interval=${SCAN_INTERVAL_MS}ms)`);
    if (lastScannedHeight > 0) console.log(`[Scanner] Resume from block ${lastScannedHeight}`);

    const loop = () => {
        scanLoop().finally(() => setTimeout(loop, SCAN_INTERVAL_MS));
    };
    loop();
}

main().catch(e => {
    console.error(`[Scanner] Fatal: ${e.message}`);
    process.exit(1);
});
