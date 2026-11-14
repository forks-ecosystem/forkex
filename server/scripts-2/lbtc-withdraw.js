'use strict';

// LBTC withdrawal tool.
//
// Usage (from /app/forkex/server):
//   node scripts/lbtc-withdraw.js balance
//   node scripts/lbtc-withdraw.js utxos [address] [minconf]
//   node scripts/lbtc-withdraw.js history [address]
//   node scripts/lbtc-withdraw.js send <address> <amount> [fee]
//
// `amount` and `fee` are LBTC amounts; the agent works in base units internally.
// If `fee` is omitted the same conservative estimate the API uses is applied.
//
// Configuration comes from the environment (lbtc-ops-env loads
// /app/forkex/.env): LBTC_AGENT_HOST, LBTC_AGENT_PORT, LBTC_AGENT_API_KEY,
// LBTC_HOT_ADDRESS and, if the address is not set, LBTC_AGENT_WALLET's first
// address. The agent's own LEGACYCOIN_HOT_WALLET must name the same wallet.
//
// On the host the .env DB_HOST=forkex-db only resolves inside the compose
// network, so this script falls back to the published port 127.0.0.1:5434 when
// it is not running in a container. Explicit LBTC_DB_*/DB_* still wins.

const http = require('http');
const fs = require('fs');
const { dbConfig } = require('./lbtc-ops-env');
const { estimateNetworkFee } = require('../utils/withdrawalFee');
const { Client } = require('pg');

const CURRENCY = 'lbtc';
const BASE_UNITS = 1e8;
const HOT_WALLET_USER_ID = Number(process.env.LBTC_HOT_USER_ID) || 1;
const AGENT_WALLET = process.env.LBTC_AGENT_WALLET || 'withdrawal';
const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || '';

// The agent runs on the host. Inside the API container it is reachable as
// host.docker.internal, while the same .env is also used by host-side scripts
// where that name does not resolve. Detect the context instead of making every
// host invocation pass an override.
const CONFIGURED_AGENT_HOST = process.env.LBTC_AGENT_HOST || '127.0.0.1';
const AGENT_HOST = !fs.existsSync('/.dockerenv') && CONFIGURED_AGENT_HOST === 'host.docker.internal'
    ? '127.0.0.1'
    : CONFIGURED_AGENT_HOST;
const AGENT_PORT = parseInt(process.env.LBTC_AGENT_PORT, 10) || 8444;

function agentCall(method, path, body, opts = {}) {
    return new Promise((resolve, reject) => {
        if (opts.requireKey && !AGENT_KEY) {
            return reject(new Error('LBTC_AGENT_API_KEY is not configured; refusing to send'));
        }
        const payload = body ? JSON.stringify(body) : '';
        const req = http.request({
            hostname: AGENT_HOST,
            port: AGENT_PORT,
            path,
            method,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': AGENT_KEY,
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let json;
                try {
                    json = data ? JSON.parse(data) : {};
                } catch (e) {
                    return reject(new Error(`agent: unparsable reply: ${data.slice(0, 200)}`));
                }
                if (json.error) return reject(new Error(`agent: ${json.error}`));
                resolve(json.result !== undefined ? json.result : json);
            });
        });
        req.on('timeout', () => req.destroy(new Error('agent timeout')));
        req.on('error', (e) => reject(new Error(`agent unreachable at ${AGENT_HOST}:${AGENT_PORT}: ${e.message}`)));
        if (payload) req.write(payload);
        req.end();
    });
}

function toBaseUnits(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number`);
    const base = Math.round(n * BASE_UNITS);
    if (base <= 0) throw new Error(`${label} is below one base unit`);
    return base;
}

function fromBaseUnits(value) {
    return Number(value) / BASE_UNITS;
}

// The hot address is a node-wallet address, not a key we own. Prefer the
// configured one; otherwise ask the agent which addresses the withdrawal
// wallet has. No default literal, because a stale address would silently send
// the operator to a wallet they did not mean to inspect.
async function getHotAddress() {
    if (process.env.LBTC_HOT_ADDRESS) return process.env.LBTC_HOT_ADDRESS;
    const info = await agentCall('GET', `/api/wallet/${encodeURIComponent(AGENT_WALLET)}/balances`);
    const first = info && Array.isArray(info.addresses) && info.addresses[0];
    if (!first || !first.address) {
        throw new Error(`agent wallet ${AGENT_WALLET} has no addresses; set LBTC_HOT_ADDRESS`);
    }
    return first.address;
}

async function getBalance(address) {
    return agentCall('GET', `/api/chain/lbtc/balance/${encodeURIComponent(address)}`);
}

async function listUtxos(address, minconf = 1) {
    const res = await agentCall(
        'GET',
        `/api/chain/lbtc/utxos/${encodeURIComponent(address)}?minconf=${encodeURIComponent(minconf)}`
    );
    return res && Array.isArray(res.utxos) ? res.utxos : [];
}

async function getHistory(address) {
    const res = await agentCall('GET', `/api/chain/lbtc/history/${encodeURIComponent(address)}`);
    return res && Array.isArray(res.entries) ? res.entries : [];
}

async function estimateFee(from, to, amountBaseUnits) {
    return agentCall('POST', '/api/chain/lbtc/estimate', {
        from,
        to,
        amount: amountBaseUnits,
    });
}

// Send from the node-owned hot wallet. The agent validates the destination and
// lets the node wallet pick its own UTXOs, so `from` identifies the wallet, not
// a key. The node also returns the fee it actually charged, which is what the
// ledger must record.
async function sendLbtc(recipientAddress, amountLbtc, feeLbtc = null) {
    const from = await getHotAddress();
    const amountBase = toBaseUnits(amountLbtc, 'amount');

    const vinfo = await agentCall('GET', `/api/chain/lbtc/validate/${encodeURIComponent(recipientAddress)}`);
    if (!vinfo || vinfo.isvalid !== true) {
        throw new Error(`invalid LBTC destination address: ${recipientAddress}`);
    }

    // The API reserves a conservative network fee before broadcasting because
    // the node, not the caller, chooses inputs. Reuse the same estimate so a
    // manual payout does not underpay a large transaction.
    const fee = feeLbtc === null || feeLbtc === undefined
        ? estimateNetworkFee(Number(amountLbtc))
        : Number(feeLbtc);
    const feeBase = toBaseUnits(fee, 'fee');

    const res = await agentCall('POST', '/api/chain/lbtc/send', {
        from,
        to: recipientAddress,
        amount: amountBase,
        fee: feeBase,
    }, { requireKey: true });

    const txid = res && (res.txid || res.tx_id);
    if (!txid) throw new Error(`agent send returned no txid: ${JSON.stringify(res).slice(0, 200)}`);
    const paidFeeBase = res.fee !== undefined ? Number(res.fee) : feeBase;

    return {
        txid,
        from,
        amount: fromBaseUnits(amountBase),
        fee: fromBaseUnits(paidFeeBase),
    };
}

// --- DB HELPERS ---

async function getDbClient() {
    const opts = dbConfig({ host: '127.0.0.1', port: 5434 });
    // The compose service name only resolves on the compose network. Host-side
    // operator runs reach the same database through its published port; the
    // monitor's wrapper does the same with LBTC_DB_*.
    if (!fs.existsSync('/.dockerenv') && opts.host === 'forkex-db') {
        opts.host = '127.0.0.1';
        opts.port = 5434;
    }
    const client = new Client(opts);
    await client.connect();
    return client;
}

// A withdrawal that cannot be written to the ledger must not be broadcast:
// recordWithdrawal would fail after the coins had already left the exchange.
// Check the same row it is going to debit before asking the agent to pay.
async function assertLedgerCanCover(db, amount, fee) {
    const total = Number(amount) + Number(fee);
    const res = await db.query(
        `SELECT balance, available FROM balances WHERE user_id = $1::int AND currency = $2 LIMIT 1`,
        [HOT_WALLET_USER_ID, CURRENCY]
    );
    if (!res.rows.length) {
        throw new Error(`user ${HOT_WALLET_USER_ID} has no ${CURRENCY} balance row; refusing to broadcast`);
    }
    const balance = Number(res.rows[0].balance);
    const available = Number(res.rows[0].available);
    // recordWithdrawal debits both columns, so a sufficient balance with less
    // available would drive available negative after the coins were already gone.
    if (!(balance >= total) || !(available >= total)) {
        throw new Error(
            `user ${HOT_WALLET_USER_ID} has ${balance} ${CURRENCY} balance / ${available} available, ` +
            `need ${total}; refusing to broadcast`
        );
    }
}

async function recordWithdrawal(db, userId, amount, txHash, address, fee = 0) {
    const total = Number(amount) + Number(fee);
    // Check rowCount: the old form fired the UPDATE and ignored the result, so a
    // user without funds still got a recorded, broadcast withdrawal with nothing
    // debited. One row for one user+currency, so anything else means the write
    // did not land and must not be papered over with a transaction row.
    try {
        await db.query('BEGIN');
        const upd = await db.query(
            `UPDATE balances SET balance = balance - $1::numeric - $3::numeric, available = available - $1::numeric - $3::numeric, updated_at = NOW()
             WHERE user_id = $2::int AND currency = $4 AND (balance - $1::numeric - $3::numeric) >= 0`,
            [amount, userId, fee, CURRENCY]
        );
        if (upd.rowCount !== 1) {
            throw new Error(`balance debit for user ${userId} touched ${upd.rowCount} rows, expected 1 (need ${total} LBTC)`);
        }
        await db.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
             VALUES ($1::int, 'withdrawal', $2::numeric, $4, 'completed', $3::numeric, $4, 'On-chain LBTC withdrawal', NULL, $5, $6, 'lbtc', '{}', NOW(), NOW())`,
            [userId, amount, fee, CURRENCY, txHash, address]
        );
        await db.query('COMMIT');
    } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        throw e;
    }
    // No user_wallets sync here on purpose. Writing b.balance into every wallet
    // of the user stamped all 13 of user 1's addresses with 7499.99 on
    // 2026-09-27, a value no single address held. user_wallets.balance is one
    // address's on-chain balance and is written from chain data by
    // check-lbtc-deposits.js, matched by address.
    console.log(`[DB] Recorded withdrawal: ${amount} LBTC to ${address}, tx: ${txHash}`);
}

// --- MAIN WITHDRAWAL FUNCTION ---

async function processWithdrawal(recipientAddress, amount, fee = null) {
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        throw new Error('amount must be a positive number');
    }

    const feeForCheck = fee === null || fee === undefined ? estimateNetworkFee(amountNumber) : Number(fee);

    console.log(`\n=== LBTC WITHDRAWAL (via legacycoreagent) ===`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Amount: ${amountNumber} LBTC`);
    if (fee !== null && fee !== undefined) console.log(`Fee: ${Number(fee)} LBTC (explicit)`);
    else console.log(`Fee: ${feeForCheck} LBTC (estimated)`);

    // Open the ledger before any coins move. If the DB is unreachable or the
    // debit cannot land, abort now: broadcasting first and discovering the
    // problem afterwards leaves a paid-out transaction with no debit, which is
    // exactly the state this script must not create.
    const db = await getDbClient();
    let sent;
    try {
        await assertLedgerCanCover(db, amountNumber, feeForCheck);
        sent = await sendLbtc(recipientAddress, amountNumber, feeForCheck);
        console.log(`Broadcast TXID: ${sent.txid}`);
    } catch (err) {
        await db.end().catch(() => {});
        throw err;
    }

    try {
        await recordWithdrawal(db, HOT_WALLET_USER_ID, sent.amount, sent.txid, recipientAddress, sent.fee);
    } catch (err) {
        // The chain accepted the transfer whatever the ledger does. Say so
        // explicitly so an operator does not retry and pay twice.
        err.message = `withdrawal ${sent.txid} was broadcast, but the DB record failed: ${err.message}`;
        throw err;
    } finally {
        await db.end().catch(() => {});
    }

    console.log(`\n=== WITHDRAWAL COMPLETE ===`);
    console.log(`TXID: ${sent.txid}`);
    console.log(`Amount: ${sent.amount} LBTC`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Fee: ${sent.fee} LBTC`);
    console.log(`Explorer: http://127.0.0.1:8083/tx/${sent.txid}`);

    return { txid: sent.txid, amount: sent.amount, fee: sent.fee, address: recipientAddress };
}

// --- CLI ---

function printUsage() {
    console.log('LBTC Withdrawal Tool (legacycoreagent)');
    console.log('Usage:');
    console.log('  node lbtc-withdraw.js balance                           - Show hot wallet balance');
    console.log('  node lbtc-withdraw.js utxos [address] [minconf]         - List UTXOs');
    console.log('  node lbtc-withdraw.js history [address]                 - List address history');
    console.log('  node lbtc-withdraw.js send <address> <amount> [fee]     - Send LBTC');
}

async function main() {
    const args = process.argv.slice(2);

    if (args[0] === 'balance') {
        const address = await getHotAddress();
        const bal = await getBalance(address);
        console.log(`Hot wallet address: ${address}`);
        console.log(`Confirmed balance: ${bal.balance} LBTC`);
        const utxos = await listUtxos(address, 1);
        console.log(`UTXOs: ${utxos.length}`);
        for (const u of utxos) {
            console.log(`  ${fromBaseUnits(u.value)} LBTC | tx:${u.txid}:${u.vout} | height:${u.height}`);
        }
        return;
    }

    if (args[0] === 'utxos') {
        const address = args[1] || await getHotAddress();
        const minconf = args[2] !== undefined ? parseInt(args[2], 10) : 1;
        if (!Number.isInteger(minconf) || minconf < 0) throw new Error('minconf must be a non-negative integer');
        const utxos = await listUtxos(address, minconf);
        for (const u of utxos) {
            console.log(`  ${fromBaseUnits(u.value)} LBTC | tx:${u.txid}:${u.vout} | height:${u.height}`);
        }
        return;
    }

    if (args[0] === 'history') {
        const address = args[1] || await getHotAddress();
        const entries = await getHistory(address);
        for (const e of entries) {
            console.log(`  ${e.type} ${e.amount_display || fromBaseUnits(e.amount) + ' LBTC'} | height:${e.height} | tx:${e.txid}`);
        }
        return;
    }

    if (args[0] === 'send') {
        if (args.length < 3) {
            console.log('Usage: node lbtc-withdraw.js send <address> <amount> [fee]');
            process.exit(1);
        }
        const address = args[1];
        const amount = parseFloat(args[2]);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
        const fee = args[3] !== undefined ? parseFloat(args[3]) : null;
        if (fee !== null && (!Number.isFinite(fee) || fee <= 0)) throw new Error('fee must be a positive number');
        await processWithdrawal(address, amount, fee);
        return;
    }

    printUsage();
}

if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
    processWithdrawal,
    sendLbtc,
    getHotAddress,
    getBalance,
    listUtxos,
    getHistory,
    estimateFee,
    recordWithdrawal,
};
