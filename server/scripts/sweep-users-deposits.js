#!/usr/bin/env node
'use strict';

// SWEEP-USERS-DEPOSITS — страховка для монитора депозитов.
//
// Раньше скрипт ходил в ноду напрямую (listunspent/sweepallraw c заголовком
// X-LegacyCoin-Wallet). Теперь вся работа с ключами и подписью — через
// legacycoreagent (127.0.0.1:8444), прямой RPC-доступ биржевому скрипту больше
// не нужен. Скоуп нодового кошелька передаётся агенту полем `wallet`
// (WithNodeWallet в lbtc.go), без него agent потребовал бы privateKey.
//
// Что делает: всё, что осталось нераспределённым на депозитных адресах
// (депозит зачислен при лежащем мониторе, реорг, неудавшийся sweep),
// переносится на staging-флот (LBTC_WITHDRAWAL_ADDR) через
// POST /api/chain/lbtc/send {sweep: true}: агент на стороне ноды выполняет
// sweepallraw — один вход-набор с адреса, один выход без сдачи.
//
// Адреса кандидатов — депозитные адреса клиентов из user_wallets
// (user_id > 1): агент адресный список нодового кошелька не отдаёт, а
// депозитные адреса биржи и так зарегистрированы в DB. Адрес, не
// принадлежащий нодовому кошельку LBTC_USER_WALLET, отклонит sweepallraw
// ошибкой и будет залогирован, остальной обход продолжится.
//
// Отличие от старой версии: агентный список UTXO (getaddressutxos) содержит
// только подтверждённые выходы, 0-conf не попадёт. Монитор сводит депозиты
// не раньше LBTC_COLLECT_CONFIRMATIONS, так что страховке это не мешает.
//
// Запуск:
//   node scripts/sweep-users-deposits.js            # выполнить перенос
//   node scripts/sweep-users-deposits.js --dry-run  # только показать, что нашли
//
// Записей в биржевой DB скрипт не делает: credited-балансы двигают монитор и
// вывод, здесь только on-chain сбор остатков.

const http = require('http');
const { dbConfig } = require('./lbtc-ops-env');
const { Client } = require('pg');

const CURRENCY = 'lbtc';
// Staging-флот, куда собираются остатки (тот же, что и раньше).
const WITHDRAWAL_ADDR = process.env.LBTC_WITHDRAWAL_ADDR || 'LbatPBt1z7jTp6u4ikgbRL46XLRtA6ZaxX';
// Нодовый кошелёк, в чьём скоупе агент выполняет sweepallraw.
const USER_WALLET = process.env.LBTC_USER_WALLET || 'users';
const AGENT_HOST = process.env.LBTC_AGENT_HOST || '127.0.0.1';
const AGENT_PORT = parseInt(process.env.LBTC_AGENT_PORT) || 8444;
const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || '';
// Сетевая комиссия sweep в базовых единицах (как в старом вызове sweepallraw).
const SWEEP_FEE_BASE = parseInt(process.env.LBTC_SWEEP_FEE) || 1000;

const BASE = 1e8; // 1 LBTC
const fmt = (base) => (Number(base) / BASE).toFixed(8);

function agentCall(method, path, body) {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : '';
		const req = http.request({
			hostname: AGENT_HOST, port: AGENT_PORT, path, method,
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
				try { json = JSON.parse(data); } catch (e) { return reject(new Error(`agent: unparsable reply: ${data.slice(0, 200)}`)); }
				if (json.error) return reject(new Error(`agent: ${json.error}`));
				resolve(json.result !== undefined ? json.result : json);
			});
		});
		req.on('error', (e) => reject(new Error(`agent unreachable at ${AGENT_HOST}:${AGENT_PORT}: ${e.message}`)));
		if (payload) req.write(payload);
		req.end();
	});
}

// Депозитные адреса клиентов из user_wallets: user_id > 1. Биржевые
// operational-кошельки (hot, cold, treasury, withdrawal-флот, fee, ...) — это
// user_id = 1 с purpose из набора audit/backup/bridge/cold/deposit/fee/hot/
// liquidity/mining/staking/treasury/withdrawal; старый скрипт их не трогал,
// потому что listunspent был скоупнут на кошелёк `users`, а флот/cold живут в
// других нодовых кошельках. Фильтр user_id > 1 держит тот же скоуп: если
// холодный кошелёк (17 598 LBTC) или флот вывода (3 549 LBTC) попадут в
// кандидатов, sweep унесёт их на staging-адрес.
async function loadCandidateAddresses(db) {
	const res = await db.query(
		`SELECT address FROM user_wallets
		  WHERE currency = $1 AND network IN ($1, 'main')
		    AND status = 'active' AND is_valid = true
		    AND user_id > 1
		    AND address IS NOT NULL AND address <> ''
		  ORDER BY id ASC`,
		[CURRENCY]
	);
	// Цель sweep не сводится сама в себя.
	const set = new Set(res.rows.map((r) => r.address));
	set.delete(WITHDRAWAL_ADDR);
	return [...set];
}

// Сводимый остаток адреса через агент (confirmed UTXO).
async function addressSpendable(address) {
	const res = await agentCall('GET', `/api/chain/lbtc/utxos/${encodeURIComponent(address)}`);
	const utxos = (res && res.utxos) || [];
	const total = utxos.reduce((s, u) => s + Number(u.value), 0);
	return { utxos: utxos.length, total };
}

// sweep адреса через агента: нода сама выбирает все его UTXO, подписывает и
// бродкастит, без сдачи. Кошелёк-владелец адреса обязан совпасть с USER_WALLET.
async function sweepAddress(address) {
	return agentCall('POST', '/api/chain/lbtc/send', {
		from: address,
		to: WITHDRAWAL_ADDR,
		amount: 0,
		fee: SWEEP_FEE_BASE,
		sweep: true,
		wallet: USER_WALLET,
	});
}

async function main() {
	const dry = process.argv.includes('--dry-run');
	const db = new Client(dbConfig());
	await db.connect();

	try {
		const addresses = await loadCandidateAddresses(db);
		console.log(`[SWEEP] кандидатов: ${addresses.length}, цель: ${WITHDRAWAL_ADDR} (кошелёк ${USER_WALLET})`);

		let found = 0;
		for (const address of addresses) {
			let spendable;
			try {
				spendable = await addressSpendable(address);
			} catch (e) {
				console.error(`[SWEEP] ERR utxos ${address}: ${e.message}`);
				continue;
			}
			if (spendable.total <= 0) continue;
			found++;
			console.log(`[SWEEP] ${address}: ${spendable.utxos} UTXO, ${fmt(spendable.total)} LBTC`);
			if (dry) {
				console.log(`DRY sweep ${address} ${fmt(spendable.total)} -> ${WITHDRAWAL_ADDR}`);
				continue;
			}
			try {
				const res = await sweepAddress(address);
				const txid = res && (res.txid || res.tx_id);
				console.log(`swept ${address} ${fmt(spendable.total)} -> ${WITHDRAWAL_ADDR} txid ${txid || JSON.stringify(res).slice(0, 100)}`);
			} catch (e) {
				console.error(`ERR sweep ${address}: ${e.message}`);
			}
		}

		if (found === 0) console.log('nothing to sweep');
	} finally {
		await db.end().catch(() => {});
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
