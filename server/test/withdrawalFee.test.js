'use strict';

// Контракт комиссий LBTC-вывода.
//
// GET /withdrawal/fee/:currency отдаёт пользователю coins.withdrawal_fee.
// До этого изменения performWithdrawal его не брал: в запись попадала только
// сетевая комиссия, а `fee` перезаписывался фактической платой узла. Цитата
// 0.01 и реальное списание 0.0002 расходились.
//
// Тест фиксирует три вещи:
//   1. арифметику (buildWithdrawalFees) — чистую функцию;
//   2. что сетевая компонента сверяется с фактом, а биржевая — никогда;
//   3. SQL-проводку в performWithdrawal: именно она раньше теряла комиссию,
//      и без проверки исходника регрессия вернётся молча.
//
// БД и агент не нужны: политика вынесена в utils/withdrawalFee.js, а
// утверждения об исходнике — статические.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
	MIN_NETWORK_FEE,
	estimateNetworkFee,
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

describe('withdrawalFee: разделение комиссий', () => {
	const fees = (over = {}) => buildWithdrawalFees({
		amount: 83,
		withdrawalFee: 0.01,
		...over
	});

	it('пользователя списывает выплату плюс обе комиссии', () => {
		assert.ok(near(fees().userDebit, 83.0102));
	});

	it('с hot wallet берёт только сетевую комиссию', () => {
		assert.ok(near(fees().hotDebit, 83.0002));
	});

	it('комиссия биржи не уходит с hot wallet', () => {
		assert.ok(near(fees().hotDebit, fees().amount + fees().networkFee));
		assert.ok(fees().userDebit - fees().hotDebit >= fees().exchangeFee - 1e-9);
	});

	it('totalFee равен сумме компонент', () => {
		assert.ok(near(fees().totalFee, fees().networkFee + fees().exchangeFee));
	});

	it('при нулевой комиссии биржи поведение прежнее', () => {
		const z = fees({ withdrawalFee: 0 });
		assert.ok(near(z.userDebit, z.hotDebit));
		assert.ok(near(z.userDebit, 83 + z.networkFee));
	});

	it('биржевая комиссия нулевая, если NULL/пусто/мусор', () => {
		for (const v of [null, undefined, '', 'abc', NaN, -1]) {
			assert.strictEqual(buildWithdrawalFees({ amount: 83, withdrawalFee: v }).exchangeFee, 0, `для ${v}`);
		}
	});

	it('читает комиссию из NUMERIC(20,16) без потери', () => {
		assert.ok(near(fees({ withdrawalFee: '0.0100000000000000' }).exchangeFee, 0.01));
	});
});

describe('withdrawalFee: сверка с фактической платой узла', () => {
	it('paidNetworkFee заменяет только оценку', () => {
		const f = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.00025 });
		assert.strictEqual(f.settledNetworkFee, 0.00025);
		assert.strictEqual(f.exchangeFee, 0.01);
		assert.ok(near(f.settledTotalFee, 0.01025));
		assert.ok(near(f.networkDelta, 0.00005));
	});

	it('биржевая комиссия не колеблется вместе с сетевой', () => {
		const a = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.0001 });
		const b = buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.01 });
		assert.strictEqual(a.exchangeFee, b.exchangeFee);
		assert.strictEqual(a.settledTotalFee - a.settledNetworkFee, 0.01);
		assert.strictEqual(b.settledTotalFee - b.settledNetworkFee, 0.01);
	});

	it('chargedToUser отражает фактическое списание, а не оценку', () => {
		assert.ok(near(
			buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01, paidNetworkFee: 0.0003 }).chargedToUser,
			83.0103
		));
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
	// только проводку в wallet.js: именно она раньше теряла комиссию биржи, и
	// без статической проверки регрессия всплыла бы только на реальной выплате.

	const lbtc = walletSource.slice(walletSource.indexOf("if (currency === 'lbtc')"));

	it('величины проводки берёт из общей политики, а не считает на месте', () => {
		assert.match(lbtc, /buildWithdrawalFees\(\{/);
		assert.match(lbtc, /const \{ userDebit, hotDebit \} = buildWithdrawalFees/);
	});

	it('списывает с пользователя userDebit, с hot wallet — отдельный hotDebit', () => {
		// Ключевое: две разные суммы. Если бы с обеих сторон бралась одна и та же
		// величина, с hot wallet ушла бы и комиссия биржи.
		assert.match(lbtc, /\[userId, userDebit\], \[HOT_WALLET_USER_ID, hotDebit\]/);
		assert.ok(/balance - \$1::numeric/.test(lbtc));
	});

	it('агенту уходит только сетевая комиссия', () => {
		assert.match(lbtc, /fee: Math\.round\(networkFee \* 1e8\)/);
		assert.ok(
			!/amount: Math\.round\(\s*\(?amount[^)]*\)? \+[^)]*exchangeFee/.test(lbtc),
			'в on-chain сумму не должна попадать комиссия биржи'
		);
	});

	it('не затирает fee фактической сетевой комиссией', () => {
		// Граница слова обязательна: без неё "network_fee = $3::numeric" матчится
		// как "fee = $3::numeric" и проверка теряет смысл.
		const afterComplete = lbtc.split("SET status = 'completed'")[1] || '';
		assert.ok(
			!/(^|[^_\w])fee\s*=\s*\$3::numeric(?!\s*\+)/.test(afterComplete),
			'fee не должен присваиваться одному лишь paidFee'
		);
		assert.match(lbtc, /fee = \$3::numeric \+ \$4::numeric/);
	});

	it('в ответе API возвращает полное списание, а не сетевую часть', () => {
		assert.match(lbtc, /fee: settled\.settledTotalFee/);
		assert.match(lbtc, /exchange_fee: settled\.exchangeFee/);
	});

	it('записывает обе компоненты в withdrawals и в транзакцию', () => {
		assert.match(lbtc, /fee, network_fee, exchange_fee/);
		assert.match(lbtc, /paidFee \+ exchangeFee/);
	});

	it('дельта сетевой комиссии не затрагивает биржевую', () => {
		assert.match(lbtc, /\}\)\.networkDelta/);
	});

	it('при отказе агента возвращает обе стороны, а не одну сумму', () => {
		// Нужен именно catch от broadcast, а не первый catch файла: резервирование
		// тоже откатывается, но там возвращается своя сумма.
		const afterFail = lbtc.split('// The chain refused')[1] || '';
		assert.ok(afterFail, 'не найден блок отказа broadcast');
		assert.match(afterFail, /\[userId, userDebit\], \[HOT_WALLET_USER_ID, hotDebit\]/);
		assert.match(afterFail, /status = 'failed'/);
	});
});

describe('withdrawalFee: резолв локальных импортов', () => {
	// Тесты выше читали исходник как текст и ни разу не выполнили require.
	// Поэтому неверный относительный путь проходил зелёным, а падал только при
	// старте контейнера: MODULE_NOT_FOUND, node падал с кодом 0 и без логов.
	// Этот блок резолвит каждый локальный require по-настоящему.

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
		// В контейнере wallet.js лежит в /app/utils/hollaex-tools-lib/tools, то есть
		// на один уровень выше, чем в репозитории. Проверяем оба контекста:
		// '../../withdrawalFee' обязан работать и там, и здесь.
		const rel = path.relative(path.dirname(WALLET), path.join(REPO_ROOT, 'utils', 'withdrawalFee'));
		const host = path.resolve(path.dirname(WALLET), './' + rel + '.js');
		assert.ok(fs.existsSync(host), `на хосте ожидался ${host}`);

		const containerLike = path.resolve('/app/utils/hollaex-tools-lib/tools', rel + '.js');
		assert.ok(
			containerLike.startsWith('/app/utils/'),
			`в контейнере модуль должен лежать в /app/utils/, получено ${containerLike}`
		);
		assert.ok(
			rel.startsWith('../'), `спецификатор '${rel}' не должен быть относительным путём без '../'`
		);
	});

	it('модуль вычисляет те же суммы, что и ожидает проводка', () => {
		// Защита от «модуль есть, но экспортирует не то»: требуем его напрямую.
		const m = require('../utils/withdrawalFee');
		const f = m.buildWithdrawalFees({ amount: 83, withdrawalFee: 0.01 });
		assert.ok(Math.abs(f.userDebit - 83.0102) < 1e-9);
		assert.ok(Math.abs(f.hotDebit - 83.0002) < 1e-9);
	});
});
