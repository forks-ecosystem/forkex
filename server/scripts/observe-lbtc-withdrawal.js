'use strict';

// Наблюдение за живым LBTC-выводом: ждёт появления новой записи в withdrawals
// и проверяет проводку целиком.
//
// Смысл в том, что после деплоя утверждать «комиссия биржи взимается» по одному
// только facty-полю нельзя: цитата, списание и запись в журнале могут
// разойтись. Скрипт сверяет все три стороны и печатает PASS/FAIL по каждой.
//
// Использование:
//   node scripts/observe-lbtc-withdrawal.js 57 83 [timeoutSec]
//
// Ничего не меняет: только SELECT.

const { Client } = require('pg');

const userId = parseInt(process.argv[2], 10);
const expectedAmount = process.argv[3] ? Number(process.argv[3]) : null;
const timeoutSec = parseInt(process.argv[4], 10) || 900;

if (!Number.isInteger(userId)) {
	console.error('usage: node observe-lbtc-withdrawal.js <userId> [expectedAmount] [timeoutSec]');
	process.exit(1);
}

const DB_URL = process.env.OBSERVE_DB_URL
  || 'postgresql://admin@127.0.0.1:5434/hollaex';
const db = new Client({ connectionString: DB_URL });
const q = (t, p) => db.query(t, p).then(r => r.rows);
const n = v => (v === null || v === undefined ? '-' : Number(v).toFixed(4));
let fails = 0;
const check = (label, ok, detail = '') => {
	if (!ok) fails++;
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

async function main() {
	await db.connect();
	const coin = (await q(`SELECT id, COALESCE(withdrawal_fee,0) withdrawal_fee FROM coins WHERE symbol='lbtc' LIMIT 1`))[0];
	const [cfg] = await q(`SELECT amount FROM fx_risk_limits WHERE enabled AND kind='single' AND currency='lbtc' LIMIT 1`);
	const startId = (await q(`SELECT COALESCE(MAX(id),0) m FROM withdrawals`))[0].m;

	const snap = async () => {
		const b = {};
		for (const r of await q(`SELECT user_id, balance, available FROM balances WHERE currency='lbtc' AND user_id IN (1,$1)`, [userId]))
			b[r.user_id] = { balance: Number(r.balance), available: Number(r.available) };
		return b;
	};
	const before = await snap();
	console.log(`  жду новую запись withdrawals для user ${userId} (старше #${startId}), до ${timeoutSec}s`);
	console.log(`  до: user${userId}=${n(before[userId] && before[userId].available)}  user1(hot)=${n(before[1] && before[1].available)}`);
	console.log(`  coins.withdrawal_fee=${coin.withdrawal_fee}  лимит разовой=${cfg.amount}`);
	console.log(`  БД: ${DB_URL.replace(/:[^:@/]*@/, ':***@')}`);

	const deadline = Date.now() + timeoutSec * 1000;
	let w = null;
	while (Date.now() < deadline) {
		const found = await q(`SELECT * FROM withdrawals WHERE id > $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`, [startId, userId]);
		if (found.length) { w = found[0]; break; }
		await new Promise(r => setTimeout(r, 3000));
	}
	if (!w) { console.log('  запись не появилась — таймаут'); await db.end(); process.exit(1); }

	// Ждём завершения: сумма финализируется после broadcast.
	let settled = w;
	for (let i = 0; i < 60 && settled.status === 'processing'; i++) {
		await new Promise(r => setTimeout(r, 5000));
		settled = (await q(`SELECT * FROM withdrawals WHERE id=$1`, [w.id]))[0];
	}

	const after = await snap();
	const dUser = before[userId] ? before[userId].balance - after[userId].balance : 0;
	const dHot = before[1] ? before[1].balance - after[1].balance : 0;
	const amount = Number(settled.amount);
	const net = Number(settled.network_fee);
	const exc = Number(settled.exchange_fee);
	const total = Number(settled.fee);

	console.log(`\n  withdrawals #${settled.id}: status=${settled.status} amount=${n(amount)} fee=${n(total)} network_fee=${n(net)} exchange_fee=${n(exc)}`);
	console.log(`  tx_hash: ${settled.tx_hash || '(нет)'}`);
	console.log(`  списано: user${userId}=${n(dUser)}  hot user1=${n(dHot)}`);

	if (settled.status !== 'completed') {
		check('вывод завершён', false, `статус ${settled.status}`);
		await db.end(); process.exit(1);
	}
	check('вывод завершён', true);
	if (expectedAmount) check('сумма совпала с ожидаемой', amount === expectedAmount, `${n(amount)} vs ${expectedAmount}`);
	check('fee = network + exchange', Math.abs(total - (net + exc)) < 1e-9, `${n(total)} = ${n(net)} + ${n(exc)}`);
	check('комиссия биржи = coins.withdrawal_fee', Math.abs(exc - Number(coin.withdrawal_fee)) < 1e-9, `${n(exc)}`);
	check('списание пользователя = amount + fee', Math.abs(dUser - (amount + total)) < 1e-6, `${n(dUser)} vs ${n(amount + total)}`);
	check('hot wallet списан на реальный отток amount+network', Math.abs(dHot - (amount + net)) < 1e-6, `${n(dHot)} vs ${n(amount + net)}`);
	check('комиссия биржи осталась в hot wallet', Math.abs((amount + total) - dHot - exc) < 1e-6, `разница ${n((amount + total) - dHot)} = ${n(exc)}`);

	const [tx] = await q(`SELECT amount, fee FROM transactions WHERE type='withdrawal' AND currency='lbtc' AND tx_hash=$1 LIMIT 1`, [settled.tx_hash]);
	if (tx) {
		check('журнал: amount + fee = списание', Math.abs((Number(tx.amount) + Number(tx.fee)) - dUser) < 1e-6, `${n(tx.amount)} + ${n(tx.fee)}`);
	} else {
		console.log('  примечание: транзакция по tx_hash в журнале не найдена');
	}
	const [mempool] = await q(`SELECT COUNT(*) c FROM transactions WHERE type='withdrawal' AND currency='lbtc' AND id > (SELECT COALESCE(MAX(id),0) FROM transactions WHERE type='withdrawal' AND currency='lbtc' AND tx_hash <> $1)`, [settled.tx_hash]).catch(() => [{ c: 0 }]);
	console.log(`  записей в журнале сверх предыдущих: ${mempool.c}`);

	console.log(fails === 0 ? '\n  ИТОГ: проводка полностью соответствует политике' : `\n  ИТОГ: расхождений ${fails}`);
	await db.end();
	process.exit(fails ? 1 : 0);
}

main().catch(async e => { console.error('  ОШИБКА:', e.message); try { await db.end(); } catch {} process.exit(1); });
