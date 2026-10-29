#!/usr/bin/env node
'use strict';

const { rpcConfig, dbConfig } = require('./lbtc-ops-env');

const CURRENCY = 'lbtc';
const APPLY = process.argv.includes('--apply');
const MIN_CONFIRMATIONS = 3;

const RPC = rpcConfig();
const DB_AUTH = dbConfig();

let rpcId = 1;
function rpc(method, params = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '1.0', id: rpcId++, method, params });
        const req = require('http').request(
            {
                host: RPC.host, port: RPC.port, method: 'POST', path: '/',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                auth: `${RPC.user}:${RPC.password}`, timeout: 20000
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) return reject(new Error(parsed.error.message));
                        resolve(parsed.result);
                    } catch (e) { reject(new Error('bad rpc json: ' + e.message)); }
                });
            }
        );
        req.on('timeout', () => req.destroy(new Error('rpc timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

async function connectDb() {
    const { Client } = require('pg');
    const candidates = [];
    if (process.env.LBTC_MONITOR_DB_HOST) {
        candidates.push({ host: process.env.LBTC_MONITOR_DB_HOST, port: Number(process.env.LBTC_MONITOR_DB_PORT || 5432) });
    }
    candidates.push({ host: '127.0.0.1', port: 5434 });
    try {
        const ip = require('child_process')
            .execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' forkex-db",
                { encoding: 'utf8', timeout: 5000 }).trim();
        if (ip) candidates.push({ host: ip, port: 5432 });
    } catch (e) {}

    let lastErr = null;
    for (const target of candidates) {
        const client = new Client({ ...target, ...DB_AUTH, connectionTimeoutMillis: 5000 });
        try { await client.connect(); return client; }
        catch (e) { lastErr = e; try { await client.end(); } catch (_) {} }
    }
    throw lastErr || new Error('no reachable database');
}

async function findFundingTx(address, amount) {
    const txids = await rpc('getaddresstxids', [address]);
    const want = Number(amount);
    for (const txid of txids || []) {
        const tx = await rpc('getrawtransaction', [txid, true]);
        if (!tx) continue;
        if ((tx.confirmations || 0) < MIN_CONFIRMATIONS) continue;
        for (const v of tx.vout || []) {
            const addrs = (v.scriptPubKey && v.scriptPubKey.addresses) || [];
            if (addrs.includes(address) && Math.abs(v.value - want) <= 1e-8) {
                return { txid, time: tx.time || null, height: tx.height || null, vout: v.n };
            }
        }
    }
    return null;
}

async function main() {
    const db = await connectDb();
    const tip = await rpc('getblockcount');
    console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | tip: ${tip} | min conf: ${MIN_CONFIRMATIONS}`);

    const { rows: wallets } = await db.query(
        `SELECT id, user_id, address, balance
           FROM user_wallets
          WHERE currency = $1 AND purpose = 'deposit' AND status = 'active'
            AND balance > 0 AND address IS NOT NULL AND address <> ''
          ORDER BY user_id, id`,
        [CURRENCY]
    );
    console.log(`deposit кошельков с балансом: ${wallets.length}\n`);

    const plan = [];
    let skipped = 0;

    for (const w of wallets) {
        const tag = `u${String(w.user_id).padStart(4)} | ${w.address} | ${w.balance}`;

        let chain;
        try {
            const ab = await rpc('getaddressbalance', [w.address]);
            chain = Number(ab.balance);
        } catch (e) {
            console.log(`  SKIP  ${tag} | getaddressbalance: ${e.message}`);
            skipped++;
            continue;
        }
        if (Math.abs(chain - Number(w.balance)) > 1e-8) {
            console.log(`  SKIP  ${tag} | сеть говорит ${chain} — не совпадает с кошельком, не трогаю`);
            skipped++;
            continue;
        }

        let funding;
        try {
            funding = await findFundingTx(w.address, w.balance);
        } catch (e) {
            console.log(`  SKIP  ${tag} | поиск tx: ${e.message}`);
            skipped++;
            continue;
        }
        if (!funding) {
            console.log(`  SKIP  ${tag} | funding tx не найден в цепочке`);
            skipped++;
            continue;
        }

        const dep = await db.query(
            `SELECT id FROM deposits
              WHERE user_id = $1::int AND tx_hash = $2 AND address = $3 AND amount = $4::numeric`,
            [w.user_id, funding.txid, w.address, w.balance]
        );
        const txRow = await db.query(
            `SELECT id FROM transactions
              WHERE tx_hash = $1 AND user_id = $2::int AND address = $3`,
            [funding.txid, w.user_id, w.address]
        );
        const bal = await db.query(
            `SELECT id, balance FROM balances WHERE user_id = $1::int AND currency = $2`,
            [w.user_id, CURRENCY]
        );

        const actions = [];
        if (dep.rows.length === 0) actions.push('deposits');
        if (txRow.rows.length === 0) actions.push('transactions');
        if (bal.rows.length === 0) actions.push('balances');
        else if (Math.abs(Number(bal.rows[0].balance) - Number(w.balance)) > 1e-8) actions.push('fx_apply_locks');
        else actions.push('fx_apply_locks');

        if (actions.length === 1 && actions[0] === 'fx_apply_locks') {
            console.log(`  OK    ${tag} | tx ${funding.txid.slice(0, 12)}… | ledger уже совпадает`);
        } else {
            console.log(`  ${APPLY ? 'DO' : 'PLAN'}   ${tag} | tx ${funding.txid.slice(0, 12)}… | +${actions.join(' +')}`);
        }

        plan.push({
            wallet: w,
            txid: funding.txid,
            time: funding.time,
            needDeposits: dep.rows.length === 0,
            needTransactions: txRow.rows.length === 0,
            needBalances: bal.rows.length === 0
        });
    }

    console.log(`\nк зачислению: ${plan.length} | пропущено: ${skipped}`);

    if (!APPLY) {
        console.log('(прогон без записи; повторите с --apply чтобы применить)');
        await db.end();
        return;
    }

    let insertedDeposits = 0, insertedTransactions = 0, insertedBalances = 0;
    const touchedUsers = [];

    for (const p of plan) {
        const w = p.wallet;
        const ts = p.time ? new Date(p.time * 1000).toISOString() : new Date().toISOString();

        try {
            await db.query('BEGIN');
            if (p.needDeposits) {
                await db.query(
                    `INSERT INTO deposits (user_id, coin_id, amount, status, tx_hash, address, fee, created_at, updated_at)
                     SELECT $1::int, co.id, $2::numeric, 'completed', $3, $4, 0, $5::timestamptz, $5::timestamptz
                       FROM coins co WHERE lower(co.symbol) = $6
                     ON CONFLICT DO NOTHING`,
                    [w.user_id, w.balance, p.txid, w.address, ts, CURRENCY]
                );
                insertedDeposits++;
            }
            if (p.needTransactions) {
                await db.query(
                    `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
                     VALUES ($1::int, 'deposit', $2::numeric, $3, 'completed', 0, '', 'On-chain LBTC deposit (reconcile from user_wallets)', NULL, $4, $5, $6, '{}', $7::timestamptz, $7::timestamptz)
                     ON CONFLICT DO NOTHING`,
                    [w.user_id, w.balance, CURRENCY, p.txid, w.address, CURRENCY, ts]
                );
                insertedTransactions++;
            }
            if (p.needBalances) {
                await db.query(
                    `INSERT INTO balances (user_id, currency, balance, available, locked, updated_at)
                     VALUES ($1::int, $2, $3::numeric, $3::numeric, 0, NOW())
                     ON CONFLICT (user_id, currency) DO NOTHING`,
                    [w.user_id, CURRENCY, w.balance]
                );
                insertedBalances++;
            }
            await db.query('SELECT fx_apply_locks($1::int)', [w.user_id]);
            await db.query('COMMIT');
            touchedUsers.push(w.user_id);
        } catch (e) {
            await db.query('ROLLBACK').catch(() => {});
            console.log(`  ERROR u${w.user_id} ${w.address}: ${e.message}`);
        }
    }

    console.log(`\ninserted: deposits=${insertedDeposits} transactions=${insertedTransactions} balances=${insertedBalances}`);

    const after = await db.query(
        `SELECT d.user_id, d.amount, d.status, d.tx_hash, d.address
           FROM deposits d
          WHERE d.user_id IN (SELECT user_id FROM user_wallets WHERE currency = $1 AND purpose = 'deposit' AND balance > 0)
          ORDER BY d.user_id, d.id`,
        [CURRENCY]
    );
    console.log('\nSELECT * FROM deposits:');
    for (const r of after.rows) {
        console.log(`  user ${r.user_id} | ${r.amount} | ${r.status} | ${String(r.tx_hash).slice(0, 16)}… | ${r.address}`);
    }

    const balAfter = await db.query(
        `SELECT b.user_id, b.currency, b.balance, b.available, b.locked
           FROM balances b
          WHERE b.user_id IN (SELECT user_id FROM user_wallets WHERE currency = $1 AND purpose = 'deposit' AND balance > 0)
          ORDER BY b.user_id`,
        [CURRENCY]
    );
    console.log('\nSELECT * FROM balances:');
    for (const r of balAfter.rows) {
        console.log(`  user ${r.user_id} | ${r.currency} | balance ${r.balance} | available ${r.available} | locked ${r.locked}`);
    }

    await db.end();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
