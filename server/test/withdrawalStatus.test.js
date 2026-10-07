'use strict';

// Контракт проекции строки `withdrawals` в ответ /user/withdrawals.
//
// Фронт (web/src/containers/TransactionsHistory) не читает таблицу, а опирается
// на форму ответа: булевы status/dismissed/rejected/processing/waiting, строковый
// type, transaction_id для ссылки в эксплорер и currency, по которому
// selectors.js ищет display_name/icon_id. Тест фиксирует именно эту форму и
// фильтры из getParamsByStatus — обе вещи раньше расходились с реальностью,
// из-за чего интерфейс показывал «Pending» вместо завершённых операций.

const assert = require('assert');
const {
	WITHDRAWAL_STATUS,
	formatWithdrawal,
	statusStringsMatching,
	readStatusFlags
} = require('../utils/withdrawalStatus');

const coin = { symbol: 'lbtc', name: 'LegacyCoin' };
const row = (overrides = {}) => ({
	id: 1,
	user_id: 58,
	coin_id: 23,
	amount: '83.0000000000',
	fee: '0.0002000000',
	status: 'completed',
	address: 'LRKg6k2qm6zN1jZZLh7BtGHCRsbUTbgjxX',
	tx_hash: 'cbe4896fa2c09cc88f8dcf0c1feb8b5f99bef60c1d7556224e574d1d2def2b59',
	created_at: new Date('2026-09-29T19:10:39Z'),
	coin,
	...overrides
});

describe('withdrawals: проекция строки', () => {
	it('completed отдаёт полный набор полей фронта', () => {
		const w = formatWithdrawal(row());
		assert.strictEqual(w.status, true);
		assert.strictEqual(w.dismissed, false);
		assert.strictEqual(w.rejected, false);
		assert.strictEqual(w.processing, false);
		assert.strictEqual(w.waiting, false);
		assert.strictEqual(w.type, 'withdrawal');
		assert.strictEqual(w.transaction_id, row().tx_hash);
		assert.strictEqual(w.txid, row().tx_hash);
		assert.strictEqual(w.address, 'LRKg6k2qm6zN1jZZLh7BtGHCRsbUTbgjxX');
		assert.strictEqual(w.currency, 'lbtc');
		assert.strictEqual(w.network, 'lbtc');
		assert.strictEqual(w.amount, 83);
		assert.strictEqual(w.fee, 0.0002);
		assert.strictEqual(w.fee_coin_display, 'LBTC');
	});

	it('currency присутствует всегда — selectors.js делает coins[currency]', () => {
		// Без currency колонки «Валюта» и «Комиссия» рисуют DEFAULT_COIN_DATA.
		assert.strictEqual(formatWithdrawal(row()).currency, 'lbtc');
		// Символ в БД может быть в любом регистре, selectors ждёт нижний.
		assert.strictEqual(formatWithdrawal(row({ coin: { symbol: 'LBTC' } })).currency, 'lbtc');
		// Отсутствие связанного объекта не должно ронять выдачу.
		const w = formatWithdrawal(row({ coin: undefined }));
		assert.strictEqual(w.currency, '');
		assert.strictEqual(w.status, true);
	});

	it('failed читается как Rejected, а не как Pending', () => {
		// Иначе сумма висит в истории как незавершённая навсегда.
		const w = formatWithdrawal(row({ status: 'failed' }));
		assert.strictEqual(w.status, false);
		assert.strictEqual(w.rejected, true);
		assert.strictEqual(w.dismissed, true);
		assert.strictEqual(w.processing, false);
	});

	it('processing не предлагает отмену и не считается отклонённым', () => {
		const w = formatWithdrawal(row({ status: 'processing', tx_hash: null }));
		assert.strictEqual(w.status, false);
		assert.strictEqual(w.processing, true);
		assert.strictEqual(w.rejected, false);
	});

	it('неизвестный статус не маскируется под completed', () => {
		const w = formatWithdrawal(row({ status: 'что-то' }));
		assert.strictEqual(w.status, false);
		assert.strictEqual(w.waiting, true);
	});

	it('выводит amount/fee числами, а не строками', () => {
		const w = formatWithdrawal(row());
		assert.strictEqual(typeof w.amount, 'number');
		assert.strictEqual(typeof w.fee, 'number');
	});
});

describe('withdrawals: фильтр по статусу', () => {
	// Фильтры приходят булевыми query-параметрами (getParamsByStatus +
	// isBoolean в hollaex-network-lib), а колонка в БД — строка.
	it('status=true (вкладка «Выполнено») -> только completed', () => {
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({ status: 'true' })), ['completed']);
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({ status: true })), ['completed']);
	});

	it('dismissed/rejected -> failed и cancelled', () => {
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({ dismissed: 'true' })), ['failed', 'cancelled']);
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({ rejected: 'true' })), ['failed', 'cancelled']);
	});

	it('processing -> только processing', () => {
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({ processing: 'true' })), ['processing']);
	});

	it('«Ожидает» (все флаги false) не находит ни одной строки', () => {
		// В словаре нет статуса, у которого все пять флагов были бы false:
		// in-flight это processing=true, отклонённое это rejected=true.
		const pending = readStatusFlags({
			status: 'false',
			dismissed: 'false',
			processing: 'false',
			rejected: 'false',
			waiting: 'false'
		});
		assert.deepStrictEqual(statusStringsMatching(pending), []);
	});

	it('без флагов фильтр не применяется (дефолт вкладки)', () => {
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({})), Object.keys(WITHDRAWAL_STATUS));
	});

	it('противоречивая комбинация даёт пустое множество, а не игнор фильтра', () => {
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({ status: 'true', dismissed: 'true' })), []);
	});

	it('мусорное значение статуса игнорируется и не ломает выборку', () => {
		assert.deepStrictEqual(readStatusFlags({ status: 'ALL', currency: 'lbtc' }), {});
		assert.deepStrictEqual(statusStringsMatching(readStatusFlags({ status: 'ALL' })), Object.keys(WITHDRAWAL_STATUS));
	});

	it('каждый статус из БД имеет однозначную проекцию', () => {
		for (const dbStatus of Object.keys(WITHDRAWAL_STATUS)) {
			const flags = WITHDRAWAL_STATUS[dbStatus];
			for (const flag of Object.keys(flags)) {
				const matched = statusStringsMatching({ [flag]: !flags[flag] });
				assert.ok(
					!matched.includes(dbStatus),
					`статус ${dbStatus} не должен попадать под ${flag}=${!flags[flag]}`
				);
			}
		}
	});
});
