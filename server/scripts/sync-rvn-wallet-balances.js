'use strict';

// sync-rvn-wallet-balances.js — зеркало sync-lbtc-wallet-balances.js для RVN.
// Обновляет user_wallets.balance/available по on-chain данным (addressindex).
// Запуск: node scripts/sync-rvn-wallet-balances.js [--apply]
//
// С addressindex=1 нода отдаёт getaddressbalance для ЛЮБОГО адреса, поэтому
// источник всегда — нода (без fallback на сканирование UTXO).

const { dbConfig } = require('./lbtc-ops-env');
// rvn-rpc.js грузит env и экспортирует dbConfig с RVN-префиксом? Нет —
// используем общий dbConfig (DB_* из .env) и rvn-rpc для RPC.
const http = require('http');
const { Client } = require('pg');
const AGENT_KEY = process.env.RVN_AGENT_API_KEY || process.env.LBTC_AGENT_API_KEY || '';
const AGENT_HOST = '127.0.0.1';
const AGENT_PORT = 8444;

function agentBalance(address) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			hostname: AGENT_HOST, port: AGENT_PORT,
			path: '/api/chain/rvn/balance/' + encodeURIComponent(address),
			headers: { 'X-Api-Key': AGENT_KEY }
		}, res => {
			let d = '';
			res.on('data', c => d += c);
			res.on('end', () => {
				try {
					const j = JSON.parse(d);
					if (j.error) return reject(new Error(j.error));
					resolve(Number(j.balance || 0));
				} catch (e) { reject(e); }
			});
		});
		req.on('error', reject);
		req.end();
	});
}

const CURRENCY = 'rvn';
const APPLY = process.argv.includes('--apply');
const DB_AUTH = dbConfig();

async function connectDb() {
	const candidates = [{ host: DB_AUTH.host, port: DB_AUTH.port }];
	for (const c of candidates) {
		const client = new Client({ ...c, ...DB_AUTH });
		try { await client.connect(); return client; } catch (e) { await client.end().catch(() => {}); }
	}
	throw new Error('не удалось подключиться к БД');
}

async function main() {
	const client = await connectDb();
	const rows = (await client.query(
		`SELECT id, user_id, address, balance, available FROM user_wallets WHERE currency = $1`,
		[CURRENCY]
	)).rows;

	let changed = 0;
	for (const r of rows) {
		let onchain;
		try {
			onchain = await agentBalance(r.address);
		} catch (e) {
			console.log(`  ${r.address}: RPC error ${e.message} — пропуск`);
			continue;
		}
		const cur = Number(r.balance || 0);
		if (Math.abs(cur - onchain) < 1e-8) {
			console.log(`  ${r.address}: ${onchain} RVN (без изменений)`);
			continue;
		}
		console.log(`  ${r.address}: ${cur} -> ${onchain} RVN${APPLY ? '' : ' (dry run)'}`);
		if (APPLY) {
			await client.query(
				`UPDATE user_wallets SET balance = $1, available = $1, updated_at = NOW() WHERE id = $2`,
				[onchain, r.id]
			);
			changed++;
		}
	}
	await client.end();
	console.log(`\nИтого изменено: ${changed} (APPLY=${APPLY})`);
	if (!APPLY) console.log('Запустите с --apply для записи.');
}

main().catch(e => { console.error(e); process.exit(1); });