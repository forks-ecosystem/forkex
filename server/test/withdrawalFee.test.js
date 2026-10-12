'use strict';

// Контракт комиссий LBTC-вывода.
//
// Модель (задание по комиссии): пользователь платит ОДНУ комиссию — тариф биржи
// (`coins.withdrawal_fee` / `withdrawal_fees[network]`), а сеть биржа оплачивает
// из этого тарифа. Поэтому:
//   * списание с пользователя = amount + exchangeFee (а не + networkFee тоже);
//   * с hot-флота уходит физический отток = amount + networkFee;
//   * отклонение фактической сети от оценки сверяется только с hot-флотом;
//   * fee_ledger фиксирует EXCHANGE_FEE (доход) и NETWORK_FEE (расход).
//
// Тест фиксирует три вещи:
//   1. арифметику (buildWithdrawalFees / computeExchangeFee) — чистые функции;
//   2. что сетевая компонента сверяется с фактом, а биржевая — никогда;
//   3. SQL-проводку в performWithdrawal: именно она теряла комиссию.
//
// БД и агент не нужны: политика вынесена в utils/withdrawalFee.js, а
// утверждения об исходнике — статические.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
	MIN_NETWORK_FEE,
	estimateNetworkFee,
	computeExchangeFee,
	buildWithdrawalFees
} = require('../utils/withdrawalFee');

const WALLET = path.join(__dirname, '..', 'utils', 'hollaex-tools-lib', 'tools', 'wallet.js');
const walletSource = fs.readFileSync(WALLET, 'utf8');

// Числа сравниваем по фиксированной точности: сложение float даёт 83.010200000000003.
const near = (a, b) => Math.abs(a - b) < 1e-9;

describe('withdrawalFee: сетевая комиссия', () => {
	it('никогда не опускается ниже минимума 0.0002', () => {
		assert.strictEqual(estimateNetworkFee(0.0001), MIN_NETWORK_FEE);
		assert.strictEqual(estimateNetworkFee(1), MIN_NETWORK_FEE);
	});

	it('растёт с размером вывода, потому что число входов растёт', () => {
		assert.ok(estimateNetworkFee(7500) > estimateNetworkFee(83));
		assert.ok(estimateNetworkFee(83) >= MIN_NETWORK_FEE);
	});

	it('неотрицательна для нулевого и отрицательного входа', () => {
		assert.ok(estimateNetworkFee(0) >= MIN_NETWORK_FEE);
		assert.ok(Number.isFinite(estimateNetworkFee(-5)));
	});
});

describe('withdrawalFee: тариф биржи (единственная комиссия)', () => {
	it('фиксированный тариф берётся как есть', () => {
		assert.strictEqual(computeExchangeFee({ amount: 83, withdrawalFee: 0.01 }), 0.01);
	});

	it('процентный тариф считается от суммы (0.05% от 40 = 0.02)', () => {
		const wf = { lbtc: { type: 'percent', value: 0.05, min: 0.01, symbol: 'lbtc' } };
		assert.ok(near(computeExchangeFee({ amount: 40, withdrawalFees: wf }), 0.02));
		assert.ok(near(computeExchangeFee({ amount: 243, withdrawalFees: wf }), 0.1215));
	});

	it('процентный тариф не опускается ниже min', () => {
		const wf = { lbtc: { type: 'percent', value: 0.05, min: 0.01, symbol: 'lbtc' } };
		assert.strictEqual(computeExchangeFee({ amount: 1, withdrawalFees: wf }), 0.01);
	});

	it('NULL/пусто/мусор дают нулевую комиссию', () => {
		for (const v of [null, undefined, '', 'abc', NaN, -1]) {
			assert.strictEqual(computeExchangeFee({ amount: 83, withdrawalFee: v }), 0, `для ${v}`);
		}
	});

	it('читает комиссию из NUMERIC(20,16) без потери', () => {
		assert.ok(near(computeExchangeFee({ amount: 83, withdrawalFee: '0.0100000000000000' }), 0.01));
	});
});

describe('withdrawalFee: разделение комиссий', () => {
	const fees = (over = {}) => buildWithdrawalFees({
		amount: 83,
		withdrawalFee: 0.01,
		...over
	});

	it('пользователя списывает выплату плюс ОДНУ комиссию (тариф)', () => {
		assert.ok(near(fees().userDebit, 83.01));
	});

	it('с hot wallet берёт выплату плюс сетевую комиссию', () => {
		assert.ok(near(fees().hotDebit, 83.0002));
	});

	it('пользователь не платит сетевую комиссию сверх тарифа', () => {
		// Списание с пользователя не должно зависеть от сетевой оценки.
		assert.ok(near(fees().userDebit, fees().amount + fees().exchangeFee));
		assert.ok(fees().hotDebit < fees().userDebit);
	});

	it('при нулевой комиссии списание равно выплате плюс сеть', () => {
		const z = fees({ withdrawalFee: 0 });
		assert.ok(near(z.userDebit, 83));
		assert.ok(near(z.hotDebit, 83 + z.networkFee));
	});

	it('chargedToUser равно списанию и не зависит от сети', () => {
		const a = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.0001 });
		const b = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.02 });
		assert.ok(near(a.chargedToUser, 83.01));
		assert.strictEqual(a.chargedToUser, b.chargedToUser);
	});
});

describe('withdrawalFee: сверка с фактической платой узла', () => {
	it('paidNetworkFee заменяет только оценку сети', () => {
		const f = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.00025 });
		assert.strictEqual(f.settledNetworkFee, 0.00025);
		assert.strictEqual(f.exchangeFee, 0.01);
		assert.ok(near(f.networkDelta, 0.00005));
		assert.ok(near(f.userDebit, 83.01));
	});

	it('биржевая комиссия не колеблется вместе с сетевой', () => {
		const a = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.0001 });
		const b = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.01 });
		assert.strictEqual(a.exchangeFee, b.exchangeFee);
		assert.strictEqual(a.exchangeIncome, b.exchangeIncome);
	});

	it('доход и расход для fee_ledger считаются из компонент', () => {
		const f = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.0003 });
		assert.strictEqual(f.exchangeIncome, 0.01);
		assert.strictEqual(f.networkExpense, 0.0003);
	});

	it('без paidNetworkFee дельта нулевая', () => {
		assert.strictEqual(feesNetworkDelta(), 0);
	});

	function feesNetworkDelta() {
		return buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01 }).networkDelta;
	}
});

describe('withdrawalFee: проводка в performWithdrawal', () => {
	// Арифметика живёт в utils/withdrawalFee и покрыта выше. Здесь фиксируем
	// только проводку в wallet.js.

	const lbtc = walletSource.slice(walletSource.indexOf("if (currency === 'lbtc')"));

	it('величины проводки берёт из общей политики, а не считает на месте', () => {
		assert.match(lbtc, /computeExchangeFee\(\{/);
		assert.match(lbtc, /buildWithdrawalFees\(\{/);
		assert.match(lbtc, /const \{ userDebit, hotDebit \} = buildWithdrawalFees/);
	});

	it('списывает с пользователя userDebit, с hot wallet — отдельный hotDebit', () => {
		assert.match(lbtc, /\[userId, userDebit\], \[HOT_WALLET_USER_ID, hotDebit\]/);
		assert.ok(/balance - \$1::numeric/.test(lbtc));
	});

	it('агенту уходит только сетевая комиссия', () => {
		assert.match(lbtc, /fee: Math\.round\(networkFee \* 1e8\)/);
	});

	it('fee в записи withdrawals — единственный тариф биржи', () => {
		assert.match(lbtc, /fee = \$4::numeric/);
	});

	it('в ответе API возвращает тариф биржи как fee', () => {
		assert.match(lbtc, /fee: settled\.exchangeFee/);
		assert.match(lbtc, /exchange_fee: settled\.exchangeFee/);
	});

	it('пишет обе компоненты в withdrawals и в транзакцию', () => {
		assert.match(lbtc, /fee, network_fee, exchange_fee/);
		assert.match(lbtc, /\[userId, amount, exchangeFee, txid, address\]/);
	});

	it('закрепляет доход и расход в fee_ledger', () => {
		assert.match(lbtc, /INSERT INTO fee_ledger/);
		assert.match(lbtc, /'NETWORK_FEE'/);
		assert.match(lbtc, /'EXCHANGE_FEE'/);
	});

	it('дельта сетевой комиссии не затрагивает пользователя', () => {
		assert.match(lbtc, /\}\)\.networkDelta/);
		// Сверка только с hot-флотом.
		assert.match(lbtc, /for \(const uid of \[isHot \? userId : HOT_WALLET_USER_ID\]\)/);
	});

	it('при отказе агента возвращает обе стороны, а не одну сумму', () => {
		const afterFail = lbtc.split('// The chain refused')[1] || '';
		assert.ok(afterFail, 'не найден блок отказа broadcast');
		assert.match(afterFail, /\[userId, userDebit\], \[HOT_WALLET_USER_ID, hotDebit\]/);
		assert.match(afterFail, /status = 'failed'/);
	});
});

describe('withdrawalFee: резолв локальных импортов', () => {
	const REPO_ROOT = path.join(__dirname, '..');
	const files = [
		'utils/hollaex-tools-lib/tools/wallet.js',
		'utils/withdrawalFee.js'
	];

	it('все локальные require из wallet.js разрешаются в файлы', () => {
		const src = fs.readFileSync(WALLET, 'utf8');
		const specs = [...src.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)].map(m => m[2]);
		assert.ok(specs.length > 0, 'не найдено ни одного относительного require');
		for (const spec of specs) {
			const target = path.resolve(path.dirname(WALLET), spec);
			assert.ok(
				fs.existsSync(target) || fs.existsSync(target + '.js') || fs.existsSync(path.join(target, 'index.js')),
				`require('${spec}') из wallet.js не резолвится в ${target}`
			);
		}
	});

	it('withdrawalFee требуется по тому же пути, что и в контейнере', () => {
		const rel = path.relative(path.dirname(WALLET), path.join(REPO_ROOT, 'utils', 'withdrawalFee'));
		const host = path.resolve(path.dirname(WALLET), './' + rel + '.js');
		assert.ok(fs.existsSync(host), `на хосте ожидался ${host}`);
		const containerLike = path.resolve('/app/utils/hollaex-tools-lib/tools', rel + '.js');
		assert.ok(containerLike.startsWith('/app/utils/'));
		assert.ok(rel.startsWith('../'));
	});

	it('модуль вычисляет те же суммы, что и ожидает проводка', () => {
		const m = require('../utils/withdrawalFee');
		const f = m.buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01 });
		assert.ok(Math.abs(f.userDebit - 83.01) < 1e-9);
		assert.ok(Math.abs(f.hotDebit - 83.0002) < 1e-9);
	});
});

describe('withdrawalFee: цитата совпадает со списанием', () => {
	it('getWithdrawalFee для lbtc берёт ту же формулу, что и performWithdrawal', () => {
		// И списание в performWithdrawal, и цитата/проверка баланса в
		// getWithdrawalFee идут через computeExchangeFee. Иначе балансовая
		// проверка требовала бы amount + 0.05, а фактически списывалось
		// amount + 0.02.
		const calls = (walletSource.match(/computeExchangeFee\(/g) || []).length;
		assert.ok(calls >= 2, `ожидалось минимум два вызова computeExchangeFee, найдено ${calls}`);
		assert.match(walletSource, /if \(currency === 'lbtc' && network !== 'email' && network !== 'fiat'\)/);
	});
});

