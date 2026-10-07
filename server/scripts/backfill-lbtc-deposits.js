'use strict';

// Backfill LBTC deposit credits that the live monitor never applied.
//
// Why this is needed: the monitor keeps a state file with lastCheckedHeight.
// It was seeded at a height near the chain tip, so deposits made at earlier
// blocks were never scanned and balances were never credited.
//
// A single transaction can pay several different addresses, and can pay the
// same address twice. Both cases exist in the data, so:
//   - verification matches the recorded amount against the outputs of that
//     address, rather than trusting the largest output;
//   - dedup is on (tx_hash, address, amount), NOT on tx_hash alone.
// Keying on tx_hash would silently drop every deposit after the first in a
// shared transaction, and the run is safe to repeat because the ledger is
// checked before any balance is touched.
//
// Usage:
//   node backfill-lbtc-deposits.js           # dry run, no writes
//   node backfill-lbtc-deposits.js --apply   # credit balances + ledger rows

const http = require('http');
const { rpcConfig, dbConfig } = require('./lbtc-ops-env');

const RPC = rpcConfig();
const CURRENCY = 'lbtc';
const MIN_CONFIRMATIONS = 3;
const APPLY = process.argv.includes('--apply');

const DB_AUTH = dbConfig();

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
    try {
        const ip = require('child_process')
            .execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' forkex-db",
                { encoding: 'utf8', timeout: 5000 }).trim();
        if (ip) candidates.push({ host: ip, port: 5432 });
    } catch (e) { /* docker not available */ }

    let lastErr = null;
    for (const target of candidates) {
        const client = new Client({ ...target, ...DB_AUTH, connectionTimeoutMillis: 5000 });
        try { await client.connect(); return client; }
        catch (e) { lastErr = e; try { await client.end(); } catch (_) {} }
    }
    throw lastErr || new Error('no reachable database');
}

// A deposit counts only if the chain itself says the recorded address received
// the recorded amount. Nothing is credited on the strength of the DB row alone.
//
// One transaction can pay several addresses (and the same address twice), so the
// match is on the exact value, not on "some output to this address". Taking the
// largest output instead would have mis-attributed a 0.0001 deposit as 151.9995.
async function verifyOnChain(txid, address, amount) {
    const tx = await rpc('getrawtransaction', [txid, true]);
    if (!tx) return { ok: false, reason: 'tx not found on chain' };
    const confs = tx.confirmations || 0;
    if (confs < MIN_CONFIRMATIONS) return { ok: false, reason: `only ${confs} confirmations` };

    const toAddr = [];
    for (const v of tx.vout || []) {
        const addrs = (v.scriptPubKey && v.scriptPubKey.addresses) || [];
        if (addrs.includes(address)) toAddr.push({ n: v.n, value: v.value });
    }
    if (toAddr.length === 0) {
        return { ok: false, reason: 'address not paid by this tx' };
    }
    const want = Number(amount);
    const hit = toAddr.find((o) => Math.abs(o.value - want) <= 1e-8);
    if (!hit) {
        return {
            ok: false,
            reason: `no output of ${want} to address (has: ${toAddr.map((o) => `${o.value}@vout${o.n}`).join(', ')})`
        };
    }
    return { ok: true, value: hit.value, confs, vout: hit.n, outsToAddr: toAddr.length };
}

// Sum of the still-unspent outputs that the node has confirmed paying `address`.
// Used for self-custodial addresses, which the node's address index does not
// cover, so getaddressbalance cannot be trusted there.
async function sumUnspentForAddress(db, address) {
    const { rows } = await db.query(
        `SELECT d.tx_hash, d.amount
           FROM deposits d JOIN coins co ON co.id = d.coin_id
          WHERE d.address = $1 AND lower(co.symbol) = $2`,
        [address, CURRENCY]
    );
    let total = 0;
    for (const d of rows) {
        let v;
        try {
            v = await verifyOnChain(d.tx_hash, address, d.amount);
        } catch (e) { continue; }
        if (!v.ok) continue;
        try {
            // third arg is include_mempool, not the address
            const out = await rpc('gettxout', [d.tx_hash, v.vout, true]);
            if (out && out.value !== undefined) total += Number(out.value);
        } catch (e) { /* output spent or unreadable */ }
    }
    return total;
}

async function main() {
    const db = await connectDb();
    const tip = await rpc('getblockcount');
    console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | tip: ${tip} | min conf: ${MIN_CONFIRMATIONS}`);

    const { rows } = await db.query(
        `SELECT d.id, d.user_id, d.amount, d.tx_hash, d.address, co.symbol
           FROM deposits d JOIN coins co ON co.id = d.coin_id
          WHERE lower(co.symbol) = $1
          ORDER BY d.user_id, d.id`,
        [CURRENCY]
    );
    console.log(`deposits to inspect: ${rows.length}\n`);

    const perUser = new Map();
    let toCredit = 0, alreadyDone = 0, rejected = 0, creditedValue = 0;

    for (const d of rows) {
        const tag = `${String(d.user_id).padStart(4)} | deposit#${String(d.id).padEnd(3)} | ${d.tx_hash.slice(0, 12)}…`;

        // Dedup on the triple, not on tx_hash alone: one transaction legitimately
        // pays several users, and can even pay the same address twice. Keying on
        // tx_hash would silently drop every deposit after the first.
        const seen = await db.query(
            `SELECT id FROM transactions
              WHERE tx_hash = $1 AND address = $2 AND amount = $3::numeric AND currency = $4
              LIMIT 1`,
            [d.tx_hash, d.address, d.amount, CURRENCY]
        );
        if (seen.rows.length > 0) {
            alreadyDone++;
            console.log(`  DONE  ${tag} | уже в ledger (transactions #${seen.rows[0].id})`);
            continue;
        }

        const v = await verifyOnChain(d.tx_hash, d.address, d.amount);
        if (!v.ok) {
            rejected++;
            console.log(`  SKIP  ${tag} | ${v.reason}`);
            continue;
        }
        if (v.outsToAddr > 1) {
            console.log(`        (в этой tx адрес получает ${v.outsToAddr} выхода — берём vout ${v.vout} = ${v.value})`);
        }

        toCredit++;
        creditedValue += v.value;
        perUser.set(d.user_id, (perUser.get(d.user_id) || 0) + v.value);
        console.log(`  CREDIT${APPLY ? '' : ' *'} ${tag} | ${v.value} LBTC | confs ${v.confs} | block ${v.height}`);

        if (APPLY) {
            await db.query(
                'UPDATE balances SET balance = balance + $1::numeric, available = available + $1::numeric, updated_at = NOW() WHERE user_id = $2::int AND currency = $3',
                [v.value, d.user_id, CURRENCY]
            ).then(async (r) => {
                if (r.rowCount === 0) {
                    await db.query(
                        `INSERT INTO balances (user_id, currency, balance, available, locked, updated_at)
                         VALUES ($1::int, $2, $3::numeric, $3::numeric, 0, NOW())`,
                        [d.user_id, CURRENCY, v.value]
                    );
                }
            });
            await db.query(
                `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
                 VALUES ($1::int, 'deposit', $2::numeric, $3, 'completed', 0, '', 'On-chain LBTC deposit (backfill)', NULL, $4, $5, 'lbtc', '{}', NOW(), NOW())`,
                [d.user_id, v.value, CURRENCY, d.tx_hash, d.address]
            );
            // user_wallets mirrors the spendable on-chain balance of the address.
            //
            // getaddressbalance is only meaningful for addresses the node actually
            // tracks. Self-custodial addresses are generated in the browser and
            // their key never reaches the node, so the address index has no record
            // of them and the RPC happily answers 0. Writing that 0 would erase a
            // real balance, so it is used only when the node confirms it knows the
            // address; otherwise the balance is summed from chain-verified outputs.
            let addrBalance = null;
            try {
                // getaddressinfo answers for any address, so its presence proves
                // nothing. Only trust getaddressbalance when the node holds the key
                // (ismine/iswatchonly); otherwise the address index has no entry
                // and the RPC returns a successful but meaningless 0.
                const info = await rpc('getaddressinfo', [d.address]);
                if (info && (info.ismine || info.iswatchonly)) {
                    const ab = await rpc('getaddressbalance', [d.address]);
                    if (ab && ab.balance !== undefined && ab.balance !== null) {
                        addrBalance = Number(ab.balance);
                    }
                }
            } catch (e) { /* not indexed: fall through to the summed value */ }
            if (addrBalance === null) {
                addrBalance = await sumUnspentForAddress(db, d.address);
            }
            const uw = await db.query(
                `UPDATE user_wallets SET balance = $1::numeric, available = $1::numeric, updated_at = NOW()
                  WHERE address = $2 AND currency = $3`,
                [addrBalance, d.address, CURRENCY]
            );
            if (uw.rowCount === 0) {
                console.log(`        note: нет user_wallets по адресу ${d.address}`);
            }
        }
    }

    console.log(`\n--- итог ---`);
    console.log(`  к зачислению: ${toCredit} на ${creditedValue.toFixed(8)} LBTC`);
    console.log(`  уже зачислено ранее: ${alreadyDone}`);
    console.log(`  отклонено (не прошло проверку сети): ${rejected}`);
    if (perUser.size) {
        console.log('  по пользователям:');
        for (const [uid, sum] of [...perUser.entries()].sort((a, b) => a[0] - b[0])) {
            console.log(`    user ${uid}: +${sum.toFixed(8)} LBTC`);
        }
    }
    if (!APPLY) console.log('\n  (это прогон без записи; повторите с --apply чтобы применить)');
    await db.end();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
