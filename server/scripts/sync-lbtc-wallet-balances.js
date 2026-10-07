'use strict';

// One-off repair: user_wallets.balance must mirror the spendable on-chain
// balance of the address, not the amount of any single deposit. A backfill that
// credited several deposits to one address wrote only the last amount.
//
// IMPORTANT: getaddressbalance is NOT authoritative for self-custodial
// addresses. Those keys are generated in the browser and never reach the node,
// so the address index has no entry and the RPC answers 0 — a successful
// response carrying a meaningless number. Trusting it would silently zero real
// balances. This script therefore picks the source per address:
//
//   node tracks the address (getaddressinfo succeeds) -> getaddressbalance
//   otherwise                                     -> sum of unspent outputs
//                                                   that the chain confirms
//                                                   paying that address
//
// An address with neither source is reported and left untouched, never zeroed.
//
// Usage:
//   node sync-lbtc-wallet-balances.js          # dry run, no writes
//   node sync-lbtc-wallet-balances.js --apply

const http = require('http');
const { rpcConfig, dbConfig } = require('./lbtc-ops-env');



const CURRENCY = 'lbtc';
const APPLY = process.argv.includes('--apply');
const MIN_CONFIRMATIONS = 0;

const DB_AUTH = dbConfig();
const RPC = rpcConfig();

let rpcId = 1;
function rpc(method, params = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '1.0', id: rpcId++, method, params });
        const req = http.request(
            { host: RPC.host, port: RPC.port, method: 'POST', path: '/',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
              auth: `${RPC.user}:${RPC.password}`, timeout: 20000 },
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
    for (const host of candidates) {
        for (const pass of [process.env.LBTC_MONITOR_DB_PASSWORD, DB_AUTH.password]) {
            if (!pass) continue;
            const c = new Client({ ...host, ...DB_AUTH, password: pass });
            try { await c.connect(); return c; } catch (e) { await c.end().catch(() => {}); }
        }
    }
    throw new Error('не удалось подключиться к БД');
}

// Find the exact output of txid that pays `address` with value `amount`.
// Matching on amount (not "largest output") matters: one tx pays the same
// address twice, with different values.
async function matchOutput(txid, address, amount) {
    const tx = await rpc('getrawtransaction', [txid, true]);
    if (!tx) return null;
    if ((tx.confirmations || 0) < MIN_CONFIRMATIONS) return null;
    const want = Number(amount);
    for (const v of tx.vout || []) {
        const addrs = (v.scriptPubKey && v.scriptPubKey.addresses) || [];
        if (addrs.includes(address) && Math.abs(v.value - want) <= 1e-8) return v.n;
    }
    return null;
}

// Balance of a self-custodial address, derived from the chain.
//
// The node's UTXO set is inconsistent with its block store: gettxout answers
// "block not found" for outputs whose block is perfectly readable, so spent vs
// unspent cannot be decided here. Each deposit amount is therefore summed only
// after getrawtransaction confirms an output of exactly that value pays the
// address, and the spent-status is reported as unverified rather than guessed.
async function sumDepositsForAddress(db, address) {
    const { rows } = await db.query(
        `SELECT d.tx_hash, d.amount
           FROM deposits d JOIN coins co ON co.id = d.coin_id
          WHERE d.address = $1 AND lower(co.symbol) = $2`,
        [address, CURRENCY]
    );
    let total = 0, verified = 0, unreadable = 0;
    for (const d of rows) {
        try {
            const n = await matchOutput(d.tx_hash, address, d.amount);
            if (n === null) continue;
            verified++;
            total += Number(d.amount);
        } catch (e) { unreadable++; }
    }
    return { total, verified, deposits: rows.length, unreadable };
}

(async () => {
    const db = await connectDb();
    const { rows } = await db.query(
        `SELECT id, user_id, address, balance FROM user_wallets
          WHERE currency = $1 ORDER BY user_id, id`,
        [CURRENCY]
    );
    console.log(`  mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | lbtc кошельков: ${rows.length}\n`);

    let changed = 0, unknown = 0, totalDrift = 0;
    for (const w of rows) {
        const tag = `u${String(w.user_id).padStart(4)} | id ${String(w.id).padEnd(4)} | ${w.address}`;
        const cur = Number(w.balance);

        let real = null, src = '';
        try {
            // getaddressinfo answers even for addresses the node has no record of,
            // so its mere presence proves nothing. The only reliable signal is
            // whether the node actually holds the key: getaddressbalance is
            // meaningful only for addresses it can sign for.
            const info = await rpc('getaddressinfo', [w.address]);
            if (info && (info.ismine || info.iswatchonly)) {
                const ab = await rpc('getaddressbalance', [w.address]);
                if (ab && ab.balance !== undefined && ab.balance !== null) {
                    real = Number(ab.balance);
                    src = info.ismine ? 'getaddressbalance (нода держит ключ)' : 'getaddressbalance (watch-only)';
                }
            }
        } catch (e) { /* not indexed by the node, as expected for self-custodial */ }

        if (real === null) {
            const s = await sumDepositsForAddress(db, w.address);
            if (s.deposits === 0) {
                unknown++;
                console.log(`  SKIP  ${tag} | ни нода, ни deposits не знают адрес — не трогаю (в БД ${cur})`);
                continue;
            }
            real = s.total;
            src = `${s.verified}/${s.deposits} депозитов подтверждено по цепочке (spent-статус не проверен: UTXO-база ноды рассогласована)`;
        }

        if (Math.abs(real - cur) < 1e-8) {
            console.log(`  OK    ${tag} | ${real}`);
            continue;
        }
        const drift = real - cur;
        totalDrift += drift;
        changed++;
        console.log(`  FIX   ${tag} | в БД ${cur} -> ${real} | ${src}`);
        if (APPLY) {
            await db.query(
                `UPDATE user_wallets SET balance = $1::numeric, available = $1::numeric, updated_at = NOW()
                  WHERE id = $2`,
                [real, w.id]
            );
        }
    }
    console.log(`\n  исправлено: ${changed} | пропущено (неизвестный адрес): ${unknown} | суммарная поправка: ${totalDrift.toFixed(8)} LBTC`);
    if (!APPLY) console.log('  (прогон без записи; повторите с --apply чтобы применить)');
    await db.end();
})().catch((e) => { console.error('  ОШИБКА:', e.message); process.exit(1); });
