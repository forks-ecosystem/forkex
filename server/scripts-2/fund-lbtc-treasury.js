#!/usr/bin/env node
// Фондирование тестовых остатков LBTC реальными монетами.
//
// Схема движения средств (модель 1):
//   1) оператор отправляет N LBTC с кошелька ноды на адрес биржи (hot/treasury, user 1);
//   2) монитор депозитов видит приход и сам начисляет его на user 1 (deposit);
//   3) этот скрипт распределяет сумму по обязательствам остальных пользователей:
//        10 x admin_deposit   (пользователи)
//        1 x admin_withdrawal (user 1, средства уходят из его счёта под чужие обязательства)
//      и уменьшает balances.user_1 на ту же сумму.
//
// Балансы правятся арифметикой `balance = balance + delta` внутри одной транзакции,
// а не read-modify-write: монитор может в этот же момент начислить депозит в hot,
// и арифметика не даст потерять обновление.
//
// По умолчанию - dry-run: ничего не пишет и не отправляет. Реальные действия только
// с --execute и явным --destination.
//
// Использование:
//   node fund-lbtc-treasury.js                          # план по обоим адресам-кандидатам
//   node fund-lbtc-treasury.js --destination <ADDR>     # план для конкретного адреса
//   node fund-lbtc-treasury.js --destination <ADDR> --execute

const http = require('http');
const { rpcConfig, dbConfig } = require('./lbtc-ops-env');
const fs = require('fs');

const CURRENCY = 'lbtc';
const MIN_CONFIRMATIONS = 3;
const EXCHANGE_USER_ID = 1;      // владелец кошельков hot/cold/treasury/...
const ALLOWED_PURPOSES = ['hot', 'treasury', 'withdrawal'];
const BACKUP_DIR = '/tmp';
// Комиссию задаём явно: дефолт ноды (1000 base units) не проходит
// min_relay_fee для транзакции ~32 КБ, которая нужна, чтобы набрать
// 7500 из 275 UTXO по ~27. Требуется ~33000 base units = 0.00033,
// берём 0.002 с запасом.
const FEE_LBTC = 0.002;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const EXECUTE = has('--execute');
const DESTINATION = val('--destination');
const AMOUNT_OVERRIDE = val('--amount');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpcCall = (method, params = []) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'f', method, params });
    const req = http.request({
        host: RPC.host, port: RPC.port, method: 'POST',
        auth: `${RPC.user}:${RPC.password}`,
        headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) },
        timeout: 60000,
    }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
            let d; try { d = JSON.parse(raw); } catch (e) { return reject(new Error('bad JSON: ' + raw.slice(0, 200))); }
            if (d.error) return reject(new Error(`${method}: ${d.error.message || JSON.stringify(d.error)}`));
            resolve(d.result);
        });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${method}: timeout`)); });
    req.end(body);
});

const RPC = rpcConfig();
const DB_AUTH = dbConfig();
async function connectDb() {
    const { Client } = require('pg');
    const candidates = ['127.0.0.1', 'forkex-db', '172.18.0.2', '172.18.0.4'];
    let lastErr;
    for (const host of candidates) {
        const c = new Client({ ...DB_AUTH, host, port: 5432 });
        try { await c.connect(); return c; } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

// Сколько нужно подкрепить: обязательство пользователя минус всё, что уже
// задокументировано его собственными депозитами/фондированием.
async function computePlan(client) {
    const { rows } = await client.query(`
        WITH documented AS (
            SELECT user_id, sum(amount) AS documented
              FROM transactions
             WHERE type IN ('deposit', 'admin_deposit')
               AND currency = $1
             GROUP BY user_id
        )
        SELECT b.user_id,
               round(b.balance, 8)                              AS liability,
               round(coalesce(d.documented, 0), 8)              AS documented,
               round(b.balance - coalesce(d.documented, 0), 8)  AS need
          FROM balances b
          LEFT JOIN documented d ON d.user_id = b.user_id
         WHERE b.currency = $1 AND b.balance <> 0
           AND b.user_id <> $2
         ORDER BY need DESC, b.user_id`,
        [CURRENCY, EXCHANGE_USER_ID]);
    const total = rows.reduce((s, r) => s + Number(r.need), 0);
    return { rows, total: Number(total.toFixed(8)) };
}

async function preflight(client, plan) {
    const notes = [];
    // адрес назначения
    if (DESTINATION) {
        // LegacyCoin-адреса ровно 34 символа. getaddressbalance на мусорном адресе
        // молча возвращает balance=0 вместо ошибки, поэтому усечённый адрес
        // проходил бы как "кошелёк пуст". Проверяем длину явно.
        if (DESTINATION.length !== 34) {
            notes.push(`СТОП: длина адреса ${DESTINATION.length}, ожидается 34 - вероятно адрес обрезан при переносе.`);
        }
        const w = await client.query(
            `SELECT id, user_id, purpose, network, status, is_valid, balance
               FROM user_wallets WHERE address = $1 AND currency = $2`,
            [DESTINATION, CURRENCY]);
        if (w.rowCount === 0) {
            notes.push(`СТОП: адрес ${DESTINATION} не найден в user_wallets для ${CURRENCY}.`);
        } else {
            const r = w.rows[0];
            if (r.user_id !== EXCHANGE_USER_ID) notes.push(`СТОП: адрес принадлежит user ${r.user_id}, а не ${EXCHANGE_USER_ID}.`);
            if (!ALLOWED_PURPOSES.includes(r.purpose)) notes.push(`СТОП: purpose='${r.purpose}', ожидается ${ALLOWED_PURPOSES.join('/')}.`);
            if (r.status !== 'active' || r.is_valid !== true) notes.push(`СТОП: адрес status=${r.status} is_valid=${r.is_valid}.`);
            if (!notes.length) notes.push(`адрес OK: user ${r.user_id}, purpose=${r.purpose}, network=${r.network}.`);
        }
    }
    // средства на кошельке ноды
    const nodeBal = Number(await rpcCall('getbalance', ['*']));
    const need = plan.total;
    notes.push(`кошелёк ноды: ${nodeBal.toFixed(8)} LBTC, требуется ${need.toFixed(8)} ` +
        `(запас ${(nodeBal - need).toFixed(8)}).`);
    if (nodeBal < need) notes.push('СТОП: на кошельке ноды недостаточно средств.');

    // уже размеченный txid этого фондирования?
    const dupe = await client.query(
        `SELECT count(*) FROM transactions
          WHERE currency = $1 AND type = 'admin_deposit' AND tx_hash IS NOT NULL
            AND tx_hash = $2`, [CURRENCY, 'FUNDING:' + (DESTINATION || '')]);
    if (dupe.rows[0].count > 0) notes.push('СТОП: для этого адреса уже есть записи фондирования.');
    return notes;
}

async function backup(client, plan) {
    const users = plan.rows.map(r => r.user_id);
    const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const bpath = `${BACKUP_DIR}/fx_backup_lbtc_funding_${t}.csv`;
    const { rows } = await client.query(
        `SELECT user_id, currency, balance, available, locked FROM balances
          WHERE currency = $1 AND user_id = ANY($2::int[]) ORDER BY user_id`,
        [CURRENCY, [EXCHANGE_USER_ID, ...users]]);
    fs.writeFileSync(bpath,
        'user_id,currency,balance,available,locked\n' +
        rows.map(r => `${r.user_id},${r.currency},${r.balance},${r.available},${r.locked}`).join('\n') + '\n');
    const m = await client.query(`SELECT max(id) AS max_id FROM transactions`);
    return { bpath, maxId: m.rows[0].max_id };
}

async function confirmDestination(addr, txid) {
    for (let i = 0; i < 40; i++) {
        const b = await rpcCall('getaddressbalance', [addr]);
        if (Number(b.balance) > 0) return b;
        await sleep(5000);
    }
    throw new Error('адрес не пополнен за отведённое время');
}

async function waitTxConfirmed(txid, timeoutSec = 900) {
    for (let i = 0; i < timeoutSec / 5; i++) {
        const r = await rpcCall('getrawtransaction', [txid, 1]).catch(() => null);
        if (r && r.confirmations !== undefined) return r;
        await sleep(5000);
    }
    throw new Error(`транзакция ${txid} не подтвердилась за отведённое время`);
}

// Ждём, пока монитор депозитов сам начислит приход на user 1 и запишет
// транзакцию. Без этого ожидания распределение могло бы списать 7499.99
// раньше, чем монитор их зачислит, и баланс user 1 на несколько секунд
// ушёл бы в минус - инвариант был бы нарушен и admission gate среагировал бы.
async function waitMonitorDeposit(addrOrTxid, timeoutSec = 900) {
    const client = await connectDb();
    try {
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() < deadline) {
            const { rows } = await client.query(
                `SELECT count(*) AS n FROM transactions
                  WHERE address = $1 AND type = 'deposit' AND currency = $2`,
                [addrOrTxid, CURRENCY]);
            if (Number(rows[0].n) > 0) return true;
            await sleep(5000);
        }
        throw new Error('монитор не зачислил депозит за отведённое время');
    } finally { await client.end().catch(() => {}); }
}

async function postAllocation(client, plan, txHash, destAddr) {
    const ref = 'FUNDING:' + destAddr;
    await client.query('BEGIN');
    try {
        // идемпотентность: не постить дважды под один txid
        const dupe = await client.query(
            `SELECT count(*) FROM transactions
              WHERE tx_hash = $1 AND type IN ('admin_deposit','admin_withdrawal')`,
            [ref]);
        if (dupe.rows[0].count > 0) { await client.query('ROLLBACK'); return { skipped: true }; }

        for (const r of plan.rows) {
            if (Number(r.need) === 0) continue;
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency,
                        description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
                 VALUES ($1::int, 'admin_deposit', $2::numeric, $3, 'completed', 0, '',
                         'LBTC treasury funding', $4::int, $5, $6, $7, '{}', NOW(), NOW())`,
                [r.user_id, r.need, CURRENCY, r.user_id, ref, destAddr, CURRENCY]);
        }
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency,
                    description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
             VALUES ($1::int, 'admin_withdrawal', $2::numeric, $3, 'completed', 0, '',
                     'LBTC allocated to user liabilities', NULL, $4, $5, $3, '{}', NOW(), NOW())`,
            [EXCHANGE_USER_ID, -plan.total, CURRENCY, ref, destAddr]);

        // атомарно: монитор может одновременно начислить депозит в этот же адрес
        await client.query(
            `UPDATE balances SET balance = balance + $1::numeric,
                    available = available + $1::numeric, updated_at = NOW()
              WHERE user_id = $2::int AND currency = $3`,
            [-plan.total, EXCHANGE_USER_ID, CURRENCY]);
        await client.query('COMMIT');
        return { skipped: false };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
}

async function verify(client, plan, destAddr) {
    const node = await client.query(
        `SELECT user_id, balance FROM balances
          WHERE currency = $1 AND user_id = ANY($2::int[]) ORDER BY user_id`,
        [CURRENCY, [EXCHANGE_USER_ID, ...plan.rows.map(r => r.user_id)]]);
    const ledger = await client.query(
        `SELECT type, count(*) AS n, round(sum(amount),8) AS total
           FROM transactions WHERE currency = $1
            AND type IN ('deposit','admin_deposit','admin_withdrawal')
          GROUP BY type ORDER BY type`, [CURRENCY]);
    const uw = await client.query(
        `SELECT id, user_id, purpose, balance, available FROM user_wallets
          WHERE address = $1`, [destAddr]);
    const chain = await rpcCall('getaddressbalance', [destAddr]);
    return { balances: node.rows, ledger: ledger.rows, wallet: uw.rows[0], chain };
}

(async () => {
    const client = await connectDb();
    try {
        const plan = await computePlan(client);
        console.log('=== План фондирования LBTC (реальные монеты под тестовые остатки) ===');
        console.log(`dest        : ${DESTINATION || '(не задан)'}`);
        console.log(`amount      : ${plan.total.toFixed(8)} ${CURRENCY}`);
        console.log(`confirmation: ${MIN_CONFIRMATIONS}`);
        console.log('\nuser_id | обязательство | задокументировано | подкрепить');
        for (const r of plan.rows) {
            console.log(`${String(r.user_id).padStart(7)} | ${String(r.liability).padStart(13)} | ${String(r.documented).padStart(16)} | ${String(r.need).padStart(10)}`);
        }
        const notes = await preflight(client, plan);
        console.log('\n=== Предпроверка ===');
        for (const n of notes) console.log('  ' + n);

        if (!EXECUTE) {
            console.log('\nDRY-RUN: ничего не изменено. Для реальных действий:');
            console.log(`  node fund-lbtc-treasury.js --destination <ADDR> --execute`);
            return;
        }
        if (notes.some(n => n.startsWith('СТОП'))) throw new Error('предпроверка не пройдена');
        if (!DESTINATION) throw new Error('--execute требует --destination');

        const bk = await backup(client, plan);
        console.log(`\nbackup     : ${bk.bpath} (transactions max id ${bk.maxId})`);

        // Защита от повторной отправки. Предыдущая версия полагалась только на
        // подтверждённый баланс адреса, а он равен нулю, пока транзакция ещё
        // в mempool - из-за этого повторный запуск слал вторую транзакцию, и
        // обе подтверждались (входы не пересекались). Теперь перед отправкой
        // ставим локальный маркер, и при его наличии отправка запрещена.
        const marker = `${BACKUP_DIR}/fx_funding_pending_${DESTINATION}.json`;
        let txid = null;
        const already = await rpcCall('getaddressbalance', [DESTINATION]).catch(() => null);
        const funded = already && Number(already.balance) >= plan.total;

        if (funded) {
            console.log(`адрес уже наполнен: balance=${already.balance} received=${already.received}`);
            console.log('отправку пропускаем, выполняем только распределение');
        } else if (fs.existsSync(marker)) {
            const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
            if (m.amount === plan.total) {
                // Отправка уже была, но ещё не подтверждена. Не отправляем
                // заново: ждём существующую транзакцию.
                console.log(`найдена незавершённая отправка ${m.txid} (маркер ${marker})`);
                console.log('повторная отправка заблокирована, ждём подтверждения');
                await waitTxConfirmed(m.txid);
                txid = m.txid;
            } else {
                throw new Error(`маркер ${marker} относится к другой сумме (${m.amount}), требуется ручное разбирательство`);
            }
        } else {
            const r = await rpcCall('sendtoaddress', [DESTINATION, plan.total.toFixed(8), FEE_LBTC.toFixed(8)]);
            // Эта нода возвращает объект, а не строку txid.
            txid = typeof r === 'string' ? r : (r && (r.txid || r.tx_id || r.hash)) || null;
            if (!txid) throw new Error(`не удалось получить txid из ответа sendtoaddress: ${JSON.stringify(r)}`);
            fs.writeFileSync(marker, JSON.stringify({ txid, amount: plan.total, dest: DESTINATION, at: new Date().toISOString() }, null, 2));
            console.log(`отправлено  : ${plan.total} -> ${DESTINATION} (комиссия ${FEE_LBTC})`);
            console.log(`txid       : ${txid}`);
        }

        const bal = await confirmDestination(DESTINATION);
        console.log(`подтверждено: balance=${bal.balance} received=${bal.received}`);
        console.log('ждём зачисления монитором...');
        // Ждём зачисления монитором по адресу назначения, а не по txid: при
        // повторном запуске txid уже неизвестен, а monitor credit привязан к
        // адресу, и это ровно то, что нам нужно дождаться.
        await waitMonitorDeposit(DESTINATION);
        console.log('монитор зачислил депозит на user 1');

        const res = await postAllocation(client, plan, txid, DESTINATION);
        console.log(res.skipped ? 'распределение: уже было, пропуск' : 'распределение: записано');

        const v = await verify(client, plan, DESTINATION);
        console.log('\n=== Проверка ===');
        console.log(`кошелёк ${DESTINATION}: в сети ${v.chain.balance}, в БД ${v.wallet.balance}/${v.wallet.available}`);
        for (const l of v.ledger) console.log(`ledger ${l.type.padEnd(18)} n=${String(l.n).padStart(3)} total=${l.total}`);
        console.log(`user ${EXCHANGE_USER_ID} balance = ${v.balances.find(b => b.user_id === EXCHANGE_USER_ID).balance}`);
        console.log('\\nГотово. Проверьте сверку: net(ledger) == sum(balances) == on-chain.');
    } finally {
        await client.end().catch(() => {});
    }
})().catch(e => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
