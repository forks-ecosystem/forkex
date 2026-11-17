'use strict';

// RVN WITHDRAWAL — вывод с биржи через legacycoreagent.
//
// Зеркало lbtc-withdraw.js для Ravencoin. Ключи и подпись принадлежат
// нодовому кошельку rvn-core (node-owned модель: биржа хранит только адреса):
// биржевой скрипт имеет только HTTP-доступ к агенту — скомпрометированный
// API-контейнер не получает ни ключ, ни RPC-креденшелы ноды.
//
// Агент принимает send только с X-Api-Key и отказывает в privateKey: RVN-нода
// сама выбирает UTXO, подписывает и бродкастит (sendtoaddress). `from`
// обязан принадлежать нодовому кошельку.
//
// Суммы по HTTP передаются в базовых единицах (1 RVN = 1e8), в CLI и DB —
// в RVN (дисплей-единицы, как во всех биржевых таблицах).
//
// Конфиг через ../lib/rvn-rpc.js: RVN_OPS_ENV_FILE -> /etc/lbtc-ops/rvn-ops.env
// -> /etc/lbtc-ops/lbtc-ops.env -> /app/forkex/.env.
//
// Запуск:
//   node scripts/rvn-withdraw.js balance                        - баланс hot-кошелька
//   node scripts/rvn-withdraw.js utxos [address]                - UTXO адреса
//   node scripts/rvn-withdraw.js send <address> <amount> [fee]  - вывод RVN
//   node scripts/rvn-withdraw.js consolidate [from] [to]        - sweep адреса в hot
//   node scripts/rvn-withdraw.js validate <address>             - проверка адреса

const http = require('http');
// rvn-rpc.js подключается ради загрузки env-файлов (RVN_AGENT_* из rvn-ops.env)
// и своего dbConfig: у RVN свои переменные LBTC_DB_* не нужны, DB_* общие.
require('../lib/rvn-rpc.js');
const { dbConfig } = require('./lbtc-ops-env');
const { Client } = require('pg');

const CURRENCY = 'rvn';
// Hot-адрес operational-флота (withdrawal): пополнение с Binance живёт здесь.
const HOT_ADDRESS = process.env.RVN_HOT_ADDRESS || 'RJyxEWsm4wSu9xnV7AWKBwMiieNDUghcUX';
// Адрес по умолчанию для consolidate: накопления пула (mining).
const MINING_ADDRESS = process.env.RVN_MINING_ADDRESS || 'RGydX7RxJKqR55UbbzB2BFvxMJ8RevSizQ';
const AGENT_HOST = process.env.RVN_AGENT_HOST || '127.0.0.1';
const AGENT_PORT = parseInt(process.env.RVN_AGENT_PORT) || 8444;
// Ключ выдаётся агенту только для send; без него агент отвечает 401.
const AGENT_KEY = process.env.RVN_AGENT_API_KEY || '';

const BASE = 1e8; // 1 RVN
function rvnToBase(rvn) { return Math.round(Number(rvn) * BASE); }
function fmt(rvn) { return Number(rvn).toFixed(8); }

// --- AGENT HTTP ---

function agentCall(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : '';
        const req = http.request({
            hostname: AGENT_HOST,
            port: AGENT_PORT,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': AGENT_KEY,
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let json;
                try { json = JSON.parse(data); } catch (e) {
                    return reject(new Error(`agent: unparsable reply (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
                }
                if (json.error) return reject(new Error(`agent: ${json.error}`));
                resolve(json.result !== undefined ? json.result : json);
            });
        });
        req.on('error', (e) => reject(new Error(`agent unreachable at ${AGENT_HOST}:${AGENT_PORT}: ${e.message}`)));
        if (payload) req.write(payload);
        req.end();
    });
}

async function validateAddress(address) {
    return agentCall('GET', `/api/chain/rvn/validate/${encodeURIComponent(address)}`);
}

async function getAddressBalance(address) {
    return agentCall('GET', `/api/chain/rvn/balance/${encodeURIComponent(address)}`);
}

async function listUtxos(address, minconf = 1) {
    const res = await agentCall('GET', `/api/chain/rvn/utxos/${encodeURIComponent(address)}?minconf=${minconf}`);
    return (res && res.utxos) || [];
}

// Подпись выполняет нода: send требует X-Api-Key; privateKey отклоняется
// агентом по дизайну (node-owned модель). Суммы — в базовых единицах.
// fee в RVN-ноде advisory: реальная комиссия возвращается агентом из
// gettransaction и логируется.
async function sendThroughAgent(fromAddress, toAddress, amountBase, all) {
    const res = await agentCall('POST', '/api/chain/rvn/send', {
        from: fromAddress,
        to: toAddress,
        amount: amountBase,
        all: !!all,
    });
    const txid = res && (res.txid || res.tx_id);
    if (!txid) throw new Error(`agent send returned no txid: ${JSON.stringify(res).slice(0, 200)}`);
    return { txid, feeBase: Number((res && res.fee) || 0) };
}

// --- DB HELPERS ---

async function getDbClient() {
    const client = new Client(dbConfig());
    await client.connect();
    return client;
}

// Дебет держателя средств и запись вывода. Для ручных выводов оператора это
// user 1 (как в lbtc-withdraw.js); для автоматических выводов клиентов
// параметр userId задаёт конкретного пользователя.
async function recordWithdrawal(db, userId, amount, txHash, address, fee = 0) {
    const total = Number(amount) + Number(fee);
    // rowCount обязателен: вывод без дебета = раздвоение средств. Одна строка
    // на user+currency, любое другое число — транзакция не прошла и не должна
    // быть замаскирована записью в ledger.
    const upd = await db.query(
        `UPDATE balances SET balance = balance - $1::numeric - $3::numeric, available = available - $1::numeric - $3::numeric, updated_at = NOW()
         WHERE user_id = $2::int AND currency = $4 AND (balance - $1::numeric - $3::numeric) >= 0`,
        [amount, userId, fee, CURRENCY]
    );
    if (upd.rowCount !== 1) {
        throw new Error(`balance debit for user ${userId} touched ${upd.rowCount} rows, expected 1 (need ${total} RVN)`);
    }
    await db.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
         VALUES ($1::int, 'withdrawal', $2::numeric, $4, 'completed', $3::numeric, $4, 'On-chain RVN withdrawal', NULL, $5, $6, 'rvn', '{}', NOW(), NOW())`,
        [userId, amount, fee, CURRENCY, txHash, address]
    );
    // user_wallets.balance сознательно не трогаем: это on-chain баланс одного
    // адреса, его пишет монитор депозитов по данным ноды.
    console.log(`[DB] Recorded withdrawal: ${fmt(amount)} RVN to ${address}, tx: ${txHash}`);
}

// --- MAIN WITHDRAWAL FUNCTION ---

async function processWithdrawal(recipientAddress, amount, fee = 0.001, userId = 1) {
    console.log(`\n=== RVN WITHDRAWAL ===`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Amount: ${fmt(amount)} RVN`);
    if (fee > 0) console.log(`Fee (advisory): ${fmt(fee)} RVN`);

    // Ранний отказ на невалидном адресе — дешевле, чем отклонённая нодой транзакция.
    const vinfo = await validateAddress(recipientAddress);
    if (!vinfo || vinfo.isvalid !== true) {
        throw new Error(`invalid recipient address: ${recipientAddress}`);
    }

    // Информативная проверка: нода выбирает UTXO со всего кошелька, так что
    // заниженный адресный баланс не повод фейлить вывод. Финальную проверку
    // (и ошибку при нехватке) выполняет нода через агента.
    const bal = await getAddressBalance(HOT_ADDRESS);
    const availableBase = Number(bal ? (bal.balance_base_units !== undefined ? bal.balance_base_units : bal.balance) : 0);
    console.log(`Hot wallet: ${HOT_ADDRESS} (agent-pinned)`);
    console.log(`Hot wallet address balance: ${fmt(availableBase / BASE)} RVN`);

    const needBase = rvnToBase(amount) + rvnToBase(fee);
    if (availableBase < needBase) {
        console.log(`[WARN] address balance ${fmt(availableBase / BASE)} RVN < всего к отправке ${fmt(amount + fee)} RVN — попытка через агента всё равно выполняется.`);
    }

    // Отправка через агента: нода выбирает UTXO, подписывает и бродкастит.
    const { txid, feeBase } = await sendThroughAgent(HOT_ADDRESS, recipientAddress, rvnToBase(amount), false);
    const actualFee = feeBase / BASE;
    console.log(`[Agent] Broadcast via agent, TXID: ${txid}`);
    console.log(`[Agent] Actual network fee: ${fmt(actualFee)} RVN`);

    // Record in DB (debit userId, default operator user 1)
    const db = await getDbClient();
    try {
        await recordWithdrawal(db, userId, amount, txid, recipientAddress, actualFee);
    } finally {
        await db.end();
    }

    console.log(`\n=== WITHDRAWAL COMPLETE ===`);
    console.log(`TXID: ${txid}`);
    console.log(`Amount: ${fmt(amount)} RVN`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Fee: ${fmt(actualFee)} RVN`);

    return { txid, amount, fee: actualFee, address: recipientAddress };
}

// Консолидация: sweep всех подтверждённых UTXO адреса в hot одним выходом
// (без change — subtractfeefromamount у ноды). Внутренний перевод, ledger не
// пишет: монеты уже учтены как обменные.
async function consolidate(fromAddress, toAddress) {
    fromAddress = fromAddress || MINING_ADDRESS;
    toAddress = toAddress || HOT_ADDRESS;
    console.log(`\n=== RVN CONSOLIDATE ===`);
    console.log(`${fromAddress} -> ${toAddress}`);
    const from = await getAddressBalance(fromAddress);
    const fromBase = Number(from ? from.balance_base_units : 0);
    if (fromBase <= 0) {
        console.log(`Нечего консолидировать: баланс ${fromAddress} = 0`);
        return null;
    }
    const { txid, feeBase } = await sendThroughAgent(fromAddress, toAddress, fromBase, true);
    console.log(`[Agent] Sweep TXID: ${txid}`);
    console.log(`[Agent] Swept: ${fmt(fromBase / BASE)} RVN, fee: ${fmt(feeBase / BASE)} RVN`);
    return { txid, swept: fromBase / BASE, fee: feeBase / BASE };
}

// --- Logging helper for UTXO lists ---

function printUtxos(utxos) {
    let total = 0;
    for (const u of utxos) {
        total += Number(u.value);
        console.log(`  ${fmt(u.value / BASE)} RVN | tx:${u.txid}:${u.vout} | height:${u.height}`);
    }
    console.log(`Total: ${fmt(total / BASE)} RVN in ${utxos.length} UTXOs`);
}

// --- CLI ---

async function main() {
    const args = process.argv.slice(2);

    if (args[0] === 'utxos') {
        const addr = args[1] || HOT_ADDRESS;
        const utxos = await listUtxos(addr);
        console.log(`UTXOs for ${addr}:`);
        printUtxos(utxos);
        return;
    }

    if (args[0] === 'balance') {
        console.log(`Hot wallet address: ${HOT_ADDRESS} (agent-pinned, node wallet signs)`);
        const bal = await getAddressBalance(HOT_ADDRESS);
        const base = Number(bal ? (bal.balance_base_units !== undefined ? bal.balance_base_units : bal.balance) : 0);
        console.log(`Confirmed balance: ${fmt(base / BASE)} RVN`);
        const utxos = await listUtxos(HOT_ADDRESS);
        console.log(`UTXOs: ${utxos.length}`);
        printUtxos(utxos);
        return;
    }

    if (args[0] === 'send') {
        if (args.length < 3) {
            console.log('Usage: node rvn-withdraw.js send <address> <amount> [fee]');
            process.exit(1);
        }
        const address = args[1];
        const amount = parseFloat(args[2]);
        const fee = args[3] !== undefined ? parseFloat(args[3]) : 0.001;
        if (!(amount > 0)) throw new Error(`bad amount: ${args[2]}`);
        await processWithdrawal(address, amount, fee);
        return;
    }

    if (args[0] === 'consolidate') {
        await consolidate(args[1], args[2]);
        return;
    }

    if (args[0] === 'validate') {
        const info = await validateAddress(args[1] || '');
        console.log(JSON.stringify(info, null, 2));
        return;
    }

    console.log('RVN Withdrawal Tool (via legacycoreagent)');
    console.log('Usage:');
    console.log('  node rvn-withdraw.js balance                          - Show hot wallet balance');
    console.log('  node rvn-withdraw.js utxos [address]                  - List UTXOs');
    console.log('  node rvn-withdraw.js send <address> <amount> [fee]    - Send RVN');
    console.log('  node rvn-withdraw.js consolidate [from] [to]          - Sweep address into hot');
    console.log('  node rvn-withdraw.js validate <address>               - Validate address');
}

main().catch(err => { console.error(err); process.exit(1); });

module.exports = { processWithdrawal, consolidate };
