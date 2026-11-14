'use strict';

// LBTC WITHDRAWAL — вывод с биржи через legacycoreagent.
//
// Раньше этот скрипт сам ходил в JSON-RPC ноды, восстанавливал приватный ключ
// из мнемоники /app/forkex/wallets/lbtc-hot-wallet.json и подписывал
// транзакции локально (bitcoinjs-lib + ручная DER/сигхаш арифметика). Теперь
// ключи и подпись принадлежат агенту: /app/legacycoreagent (systemd
// legacycoreagent.service) держит нодовый hot-кошелёк и подписывает send на
// стороне ноды. Биржевой скрипт мнемоники больше не касается и имеет только
// HTTP-доступ к агенту — скомпрометированный API-контейнер не получает ключ.
//
//Агент подписывает, только если `from` принадлежит нодовому кошельку
// (LEGACYCOIN_HOT_WALLET, по умолчанию `withdrawal`), так что вывод всегда
// идёт с operational-флота; `to` — внешний адрес получателя.
//
// Суммы по HTTP передаются в базовых единицах (1 LBTC = 1e8), в CLI и DB —
// в LBTC, как и раньше.
//
// Запуск:
//   node scripts/lbtc-withdraw.js balance                        - баланс hot-кошелька
//   node scripts/lbtc-withdraw.js utxos [address]                - UTXO адреса
//   node scripts/lbtc-withdraw.js send <address> <amount> [fee]  - вывод LBTC
//   node scripts/lbtc-withdraw.js validate <address>             - проверка адреса
//
// Конфиг: LBTC_AGENT_HOST/PORT/API_KEY и LBTC_HOT_ADDRESS берутся из окружения
// (загружается через ./lbtc-ops-env.js: /etc/lbtc-ops/lbtc-ops.env, /app/forkex/.env).

const http = require('http');
const { dbConfig } = require('./lbtc-ops-env');
const { Client } = require('pg');

const CURRENCY = 'lbtc';
// Hot-адрес operational-флота узла (тот же, что и в fee-sweep.js).
const HOT_ADDRESS = process.env.LBTC_HOT_ADDRESS || 'LQehzjT3YXhTiQD8bVzM1suVSL2Ty3JZYB';
const AGENT_HOST = process.env.LBTC_AGENT_HOST || '127.0.0.1';
const AGENT_PORT = parseInt(process.env.LBTC_AGENT_PORT) || 8444;
// Ключ выдаётся агенту только для send; без него агент отвечает 401.
const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || '';

const BASE = 1e8; // 1 LBTC
function lbtcToBase(lbtc) { return Math.round(Number(lbtc) * BASE); }
function fmt(lbtc) { return Number(lbtc).toFixed(8); }

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
    return agentCall('GET', `/api/chain/lbtc/validate/${encodeURIComponent(address)}`);
}

async function getAddressBalance(address) {
    return agentCall('GET', `/api/chain/lbtc/balance/${encodeURIComponent(address)}`);
}

async function listUtxos(address, minconf = 1) {
    const res = await agentCall('GET', `/api/chain/lbtc/utxos/${encodeURIComponent(address)}?minconf=${minconf}`);
    return (res && res.utxos) || [];
}

// Подпись выполняет нода: send требует X-Api-Key и отправляет только с
// контролируемого агентом hot-кошелька. Суммы — в базовых единицах.
async function sendThroughAgent(toAddress, amountBase, feeBase) {
    const res = await agentCall('POST', '/api/chain/lbtc/send', {
        from: HOT_ADDRESS,
        to: toAddress,
        amount: amountBase,
        fee: feeBase,
    });
    const txid = res && (res.txid || res.tx_id);
    if (!txid) throw new Error(`agent send returned no txid: ${JSON.stringify(res).slice(0, 200)}`);
    return txid;
}

// --- DB HELPERS ---

async function getDbClient() {
    const client = new Client(dbConfig());
    await client.connect();
    return client;
}

async function recordWithdrawal(db, userId, amount, txHash, address, fee = 0) {
    const total = Number(amount) + Number(fee);
    // Check rowCount: the old form fired the UPDATE and ignored the result, so a
    // user without funds still got a recorded, broadcast withdrawal with nothing
    // debited. One row for one user+currency, so anything else means the write
    // did not land and must not be papered over with a transaction row.
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
    // No user_wallets sync here on purpose. Writing b.balance into every wallet
    // of the user stamped all 13 of user 1's addresses with 7499.99 on
    // 2026-09-27, a value no single address held. user_wallets.balance is one
    // address's on-chain balance and is written from chain data by
    // check-lbtc-deposits.js, matched by address.
    console.log(`[DB] Recorded withdrawal: ${fmt(amount)} LBTC to ${address}, tx: ${txHash}`);
}

// --- MAIN WITHDRAWAL FUNCTION ---

async function processWithdrawal(recipientAddress, amount, fee = 0.0001) {
    console.log(`\n=== LBTC WITHDRAWAL ===`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Amount: ${fmt(amount)} LBTC`);
    console.log(`Fee: ${fmt(fee)} LBTC`);

    // Ранний отказ на невалидном адресе — дешевле, чем отклонённая нодой транзакция.
    const vinfo = await validateAddress(recipientAddress);
    if (!vinfo || vinfo.isvalid !== true) {
        throw new Error(`invalid recipient address: ${recipientAddress}`);
    }

    // Проверка перед отправкой — только информативная: sendtoaddress на ноде
    // выбирает UTXO со всего кошелька, а не с одного адреса, поэтому
    // заниженный адресный баланс не повод фейлить вывод. Финальную проверку
    // баланса выполняет агент.
    const bal = await getAddressBalance(HOT_ADDRESS);
    const availableBase = Number(bal ? (bal.balance_base_units !== undefined ? bal.balance_base_units : bal.balance) : 0);
    console.log(`Hot wallet: ${HOT_ADDRESS} (agent-pinned)`);
    console.log(`Hot wallet address balance: ${fmt(availableBase / BASE)} LBTC`);

    const needBase = lbtcToBase(amount) + lbtcToBase(fee);
    if (availableBase < needBase) {
        console.log(`[WARN] address balance ${fmt(availableBase / BASE)} LBTC < всего к отправке ${fmt(amount + fee)} LBTC — попытка через агента всё равно выполняется.`);
    }

    // Отправка через агент: нода выбирает UTXO, подписывает и бродкастит.
    const txid = await sendThroughAgent(recipientAddress, lbtcToBase(amount), lbtcToBase(fee));
    console.log(`[Agent] Broadcast via agent, TXID: ${txid}`);

    // Record in DB (deduct from hot wallet user_id=1)
    const db = await getDbClient();
    try {
        await recordWithdrawal(db, 1, amount, txid, recipientAddress, fee);
    } finally {
        await db.end();
    }

    console.log(`\n=== WITHDRAWAL COMPLETE ===`);
    console.log(`TXID: ${txid}`);
    console.log(`Amount: ${fmt(amount)} LBTC`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Fee: ${fmt(fee)} LBTC`);
    console.log(`Explorer: http://127.0.0.1:8083/tx/${txid}`);

    return { txid, amount, fee, address: recipientAddress };
}

// --- Logging helper for UTXO lists ---

function printUtxos(utxos) {
    let total = 0;
    for (const u of utxos) {
        total += Number(u.value);
        console.log(`  ${fmt(u.value / BASE)} LBTC | tx:${u.txid}:${u.vout} | height:${u.height}`);
    }
    console.log(`Total: ${fmt(total / BASE)} LBTC in ${utxos.length} UTXOs`);
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
        console.log(`Confirmed balance: ${fmt(base / BASE)} LBTC`);
        const utxos = await listUtxos(HOT_ADDRESS);
        console.log(`UTXOs: ${utxos.length}`);
        printUtxos(utxos);
        return;
    }

    if (args[0] === 'send') {
        if (args.length < 3) {
            console.log('Usage: node lbtc-withdraw.js send <address> <amount> [fee]');
            process.exit(1);
        }
        const address = args[1];
        const amount = parseFloat(args[2]);
        const fee = parseFloat(args[3]) || 0.0001;
        if (!(amount > 0)) throw new Error(`bad amount: ${args[2]}`);
        await processWithdrawal(address, amount, fee);
        return;
    }

    if (args[0] === 'validate') {
        const info = await validateAddress(args[1] || '');
        console.log(JSON.stringify(info, null, 2));
        return;
    }

    console.log('LBTC Withdrawal Tool (via legacycoreagent)');
    console.log('Usage:');
    console.log('  node lbtc-withdraw.js balance                     - Show hot wallet balance');
    console.log('  node lbtc-withdraw.js utxos [address]             - List UTXOs');
    console.log('  node lbtc-withdraw.js send <address> <amount> [fee] - Send LBTC');
    console.log('  node lbtc-withdraw.js validate <address>          - Validate address');
}

main().catch(err => { console.error(err); process.exit(1); });

module.exports = { processWithdrawal };
