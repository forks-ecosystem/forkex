'use strict';

// FEE_SWEEP — перенос накопленной комиссии биржи на fee-кошелёк.
//
// Модель (задание по комиссии): сетевую комиссию биржа платит из тарифа, а
// начисленный доход (EXCHANGE_FEE минус фактический расход NETWORK_FEE) остаётся
// на флоте узла. Этот перенос — ВНУТРЕННЕЕ перемещение средств, а не новый доход:
// балансы пользователей/биржи не меняются, меняется только адрес, где лежат уже
// заработанные монеты.
//
// Что делает:
//   1. Считает необработанные строки fee_ledger (status='recorded', reference_id
//      IS NULL) и их сальдо: sum(EXCHANGE_FEE) - sum(NETWORK_FEE).
//   2. Пишет строку в fee_transfers (status='pending') и помечает строки
//      fee_ledger reference_id = id переноса, status='swept'.
//   3. Шлёт сальдо с hot-адреса узла (кошелёк, заданный LBTC_AGENT wallet) на
//      fee-адрес через агент.
//   4. Отмечает перенос completed/failed; при отказе снимает пометки.
//
// Запуск:
//   node scripts/fee-sweep.js            # dry-run: только показать сальдо
//   node scripts/fee-sweep.js --execute  # выполнить перенос
//
// По умолчанию — dry-run. Реальный перевод требует явного --execute.

const http = require('http');
const { dbConfig } = require('./lbtc-ops-env');
const { Client } = require('pg');

const CURRENCY = 'lbtc';
// On-chain named wallet `fee_withdrawal` (doc174): withdrawal commissions are
// swept from the operational `withdrawal` buffer to this dedicated block.
const FEE_ADDRESS = process.env.LBTC_FEE_ADDRESS || 'LbkwdH7SpPwGxSeSbZ8YeqyMStMCZ6TMrZ';
const HOT_ADDRESS = process.env.LBTC_HOT_ADDRESS || 'LQehzjT3YXhTiQD8bVzM1suVSL2Ty3JZYB';
const AGENT_HOST = process.env.LBTC_AGENT_HOST || '172.17.0.1';
const AGENT_PORT = parseInt(process.env.LBTC_AGENT_PORT) || 8444;
const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || '';
// Нижняя граница сетевой комиссии переноса (1000 базовых единиц на KB сети).
const SWEEP_FEE_BASE = parseInt(process.env.LBTC_FEE_SWEEP_FEE) || 1000;
// Не переносить пыль меньше этого (в базовых единицах, 1 LBTC = 1e8).
const MIN_SWEEP_BASE = parseInt(process.env.LBTC_FEE_SWEEP_MIN) || 10000000; // 0.1 LBTC

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

const fmt = (base) => (Number(base) / 1e8).toFixed(8);

async function main() {
	const execute = process.argv.includes('--execute');
	const db = new Client(dbConfig());
	await db.connect();

	let transferId = null;
	let markedRows = [];
	try {
		// Санити: адрес назначения принимается узлом.
		const vinfo = await agentCall('GET', `/api/chain/lbtc/validate/${encodeURIComponent(FEE_ADDRESS)}`);
		if (!vinfo || vinfo.isvalid !== true) {
			throw new Error(`fee address rejected by node: ${FEE_ADDRESS}`);
		}

		const coinRow = await db.query(`SELECT id FROM coins WHERE symbol = $1 LIMIT 1`, [CURRENCY]);
		if (!coinRow.rows.length) throw new Error('lbtc coin row missing');
		const coinId = coinRow.rows[0].id;

		await db.query('BEGIN');
		const pending = await db.query(
			`SELECT id, type, amount FROM fee_ledger
			  WHERE currency = $1 AND status = 'recorded' AND reference_id IS NULL
			  ORDER BY id FOR UPDATE`,
			[CURRENCY]
		);
		if (!pending.rows.length) {
			await db.query('ROLLBACK');
			console.log('Нечего переносить: нет необработанных строк fee_ledger.');
			return;
		}

		let income = 0;
		let expense = 0;
		for (const r of pending.rows) {
			const a = Number(r.amount) || 0;
			if (r.type === 'EXCHANGE_FEE') income += a;
			else if (r.type === 'NETWORK_FEE') expense += a;
		}
		const net = income - expense;
		const netBase = Math.round(net * 1e8);

		console.log(`[FEE_SWEEP] строк=${pending.rows.length} доход=${income.toFixed(8)} расход=${expense.toFixed(8)} сальдо=${net.toFixed(8)} LBTC`);
		if (netBase < MIN_SWEEP_BASE) {
			await db.query('ROLLBACK');
			console.log(`Сальдо ${net.toFixed(8)} LBTC ниже порога ${fmt(MIN_SWEEP_BASE)} — перенос пропущен.`);
			return;
		}
		if (!execute) {
			await db.query('ROLLBACK');
			console.log(`DRY-RUN: к переносу ${net.toFixed(8)} LBTC на ${FEE_ADDRESS} (${pending.rows.length} строк). Запустите с --execute для отправки.`);
			return;
		}

		const insTransfer = await db.query(
			`INSERT INTO fee_transfers (coin_id, amount, fee_address, status, comment, created_at)
			 VALUES ($1::int, $2::numeric, $3, 'pending', $4, NOW()) RETURNING id`,
			[coinId, net, FEE_ADDRESS, `FEE_SWEEP of ${pending.rows.length} fee_ledger rows`]
		);
		transferId = insTransfer.rows[0].id;
		markedRows = pending.rows.map((r) => r.id);
		await db.query(
			`UPDATE fee_ledger SET reference_id = $1, status = 'swept' WHERE id = ANY($2::bigint[])`,
			[transferId, markedRows]
		);
		await db.query('COMMIT');

		const sres = await agentCall('POST', '/api/chain/lbtc/send', {
			from: HOT_ADDRESS,
			to: FEE_ADDRESS,
			amount: netBase,
			fee: SWEEP_FEE_BASE,
		});
		const txid = sres && (sres.txid || sres.tx_id);
		if (!txid) throw new Error(`agent send returned no txid: ${JSON.stringify(sres).slice(0, 200)}`);

		await db.query(
			`UPDATE fee_transfers SET status = 'completed', tx_hash = $2, confirmed_at = NOW() WHERE id = $1::int`,
			[transferId, txid]
		);
		console.log(`[FEE_SWEEP] OK: перенос #${transferId} ${net.toFixed(8)} LBTC -> ${FEE_ADDRESS}, txid ${txid}`);
	} catch (err) {
		await db.query('ROLLBACK').catch(() => {});
		if (transferId) {
			await db.query(`UPDATE fee_transfers SET status = 'failed', comment = COALESCE(comment,'') || ' | ' || $2 WHERE id = $1::int`, [transferId, String(err.message).slice(0, 300)]).catch(() => {});
			if (markedRows.length) {
				await db.query(`UPDATE fee_ledger SET reference_id = NULL, status = 'recorded' WHERE id = ANY($1::bigint[])`, [markedRows]).catch(() => {});
			}
		}
		console.error(`[FEE_SWEEP] error: ${err.message}`);
		process.exitCode = 1;
	} finally {
		await db.end().catch(() => {});
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
