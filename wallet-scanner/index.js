'use strict';

const bitcoin = require('bitcoinjs-lib');
const { Pool } = require('pg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Credentials and endpoints come from the environment, supplied by
// wallet-scanner.service through /etc/lbtc-ops/wallet-scanner.env. They were
// previously hardcoded here, and the RPC pair was additionally inlined into
// the command line below, so the constants were dead code.
function requireEnv(name) {
    const v = process.env[name];
    if (v === undefined || v === '') {
        throw new Error(`${name} is not set; see /etc/lbtc-ops/wallet-scanner.env`);
    }
    return v;
}

const RPC_PORT = Number(requireEnv('LBTC_RPC_PORT'));
const RPC_HOST = requireEnv('LBTC_RPC_HOST');
const CLI_PATH = process.env.LBTC_CLI_PATH || '/home/coin/go/bin/legacycoin-cli';

const RPC_USER = requireEnv('LBTC_RPC_USER');
const RPC_PASSWORD = requireEnv('LBTC_RPC_PASSWORD');

const DB_CONFIG = {
    host: requireEnv('LBTC_DB_HOST'),
    port: Number(requireEnv('LBTC_DB_PORT')),
    user: requireEnv('LBTC_DB_USER'),
    password: requireEnv('LBTC_DB_PASSWORD'),
    database: requireEnv('LBTC_DB_NAME'),
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
    const cmd = `${CLI_PATH} -rpcport=${RPC_PORT} -rpcconnect=${RPC_HOST} -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASSWORD} ${method} ${args.join(' ')} 2>&1`;
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

// An address maps to exactly one pubkey hash, so the RPC answer never changes and
// is worth caching: re-validating every address on every cycle would fork a
// legacycoin-cli process per address per 15s. `null` is cached too, so a bad
// address is reported once instead of on every cycle.
const validatedHashes = new Map();

function describe(a) {
    return `user=${a.user_id} addr=${a.address} hash=${a.pubkey_hash}`;
}

// Re-reads user_wallets and rebuilds the match table.
//
// This used to run only once at startup, which silently broke every address the
// user added afterwards: the scanner kept matching against a snapshot from boot
// and never saw the new deposit address until the service was restarted by hand.
// Refreshed per cycle now — the extra work is one indexed query per 15s.
async function loadKnownAddresses(initial = false) {
    const res = await pool.query(
        `SELECT uw.user_id, uw.address
         FROM user_wallets uw
         WHERE uw.currency = 'lbtc' AND uw.is_valid = true AND uw.address IS NOT NULL`
    );

    const next = [];
    for (const row of res.rows) {
        let pubkeyHash = validatedHashes.get(row.address);
        if (pubkeyHash === undefined) {
            pubkeyHash = null;
            try {
                const info = rpcCall('validateaddress', row.address);
                if (info && info.isvalid && info.pubkey_hash_hex) pubkeyHash = info.pubkey_hash_hex;
            } catch (e) {
                console.error(`[Scanner] Failed to validate ${row.address}: ${e.message}`);
            }
            validatedHashes.set(row.address, pubkeyHash);
        }
        if (pubkeyHash) next.push({ user_id: row.user_id, address: row.address, pubkey_hash: pubkeyHash });
    }

    const before = new Set(knownAddresses.map(describe));
    const after = new Set(next.map(describe));
    for (const d of after) if (!before.has(d)) console.log(`[Scanner] + ${d}`);
    for (const d of before) if (!after.has(d)) console.log(`[Scanner] - ${d}`);

    knownAddresses = next;
    if (initial) {
        console.log(`[Scanner] Loaded ${knownAddresses.length} known addresses`);
        for (const a of knownAddresses) {
            console.log(`[Scanner]  user=${a.user_id} addr=${a.address.slice(0,16)}... hash=${a.pubkey_hash.slice(0,16)}...`);
        }
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
    // Hybrid template: OP_0 OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG. Same
    // length as P2PKH but a different leading opcode, so without this branch
    // every lhyb1Z deposit address was silently skipped instead of credited.
    if (hex.startsWith('00a914') && hex.endsWith('88ac') && hex.length === 50) {
        return hex.slice(6, 46);
    }
    return null;
}

// Dedup is on (tx_hash, address, amount), not on tx_hash alone. One transaction
// routinely pays several addresses — and can pay the same address twice (the
// chain data has both: tx b25e8dc7 pays LSUsrwZW... 151.9995 and 0.0001).
// Keying on tx_hash alone made the scanner stop at the first output it credited
// and silently drop the rest.
async function depositExists(txHash, address, amountLbtc) {
    const res = await pool.query(
        `SELECT id FROM deposits WHERE tx_hash = $1 AND address = $2 AND amount = $3::numeric LIMIT 1`,
        [txHash, address, amountLbtc.toFixed(8)]
    );
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

        for (const out of tx.outs) {
            const valueLbtc = Number(out.value) / 100000000;
            if (valueLbtc <= 0) continue;

            const pubkeyHash = extractPubkeyHash(out.script);
            if (!pubkeyHash) continue;

            const user = knownAddresses.find(a => a.pubkey_hash === pubkeyHash);
            if (!user) continue;

            if (await depositExists(txid, user.address, valueLbtc)) continue;

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
        await loadKnownAddresses();
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
    await loadKnownAddresses(true);
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
