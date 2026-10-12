'use strict';

// Комиссии LBTC-вывода: одна формула, одно место.
//
// Модель (задание по комиссии): биржа взимает с пользователя ОДНУ комиссию за
// вывод — это тариф `coins.withdrawal_fee` / `coins.withdrawal_fees[network]`,
// выраженный процентом от суммы и не ниже `min`. Ожидаемую сетевую комиссию
// биржа включает в этот тариф и платит её сама: пользователь доплачивает только
// тариф, поэтому `GET /withdrawal/fee/:currency` и реальное списание совпадают.
//
// Разделение принципиально:
//   * сеть  — реальный отток: получателю уходит amount, майнеру networkFee;
//   * биржа — тариф exchangeFee; он остаётся на флоте узла до FEE_SWEEP и
//     учитывается в fee_ledger (EXCHANGE_FEE — доход, NETWORK_FEE — расход).
//
// Раньше с пользователя брали `amount + networkFee + exchangeFee`, то есть
// цитата `GET /withdrawal/fee` (0.01) расходилась с фактическим списанием
// (0.0102). Здесь сводим к одной сумме — тарифу биржи.
//
// Модуль чистый (только арифметика), чтобы правило можно было зафиксировать
// тестом без БД и без агента.

const COIN_SYMBOL = 'lbtc';

// Нижняя граница сетевой комиссии: 20 000 базовых единиц = 0.0002 LBTC.
const MIN_NETWORK_FEE = 0.0002;

// Оценка размера транзакции для расчёта комиссии. Сеть берёт 4 сатоши за байт,
// округляя вверх до килобайта.
const estimateNetworkFee = (amount) => {
	const inputs = Math.max(1, Math.ceil((amount + 0.001) / 40));
	const sizeBytes = 10 + inputs * 148 + 68;
	return Math.max(Math.ceil(sizeBytes / 1000) * 1000 * 4, MIN_NETWORK_FEE * 1e8) / 1e8;
};

// `withdrawalFee` приходит из coins.withdrawal_fee как NUMERIC(20,16) —
// приводим к Number один раз здесь, чтобы вниз по коду не таскать строку.
const toFee = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

// Единственная комиссия, которую платит пользователь: тариф биржи.
//   * `withdrawal_fees[network].type === 'percent'` — процент от суммы с полом `min`;
//   * иначе — фиксированное значение из per-network конфига или из withdrawal_fee.
const computeExchangeFee = ({ amount, withdrawalFee, withdrawalFees }) => {
	if (withdrawalFees && typeof withdrawalFees === 'object') {
		const cfg = withdrawalFees[COIN_SYMBOL] || withdrawalFees['lbtc'] || null;
		if (cfg) {
			if (cfg.type === 'percent' && Number(cfg.value) > 0) {
				const percent = (Number(amount) * Number(cfg.value)) / 100;
				const floor = toFee(cfg.min);
				return floor > 0 ? Math.max(percent, floor) : percent;
			}
			if (cfg.value !== undefined) {
				return toFee(cfg.value);
			}
		}
	}
	return toFee(withdrawalFee);
};

// Собирает все величины проводки сразу, чтобы вызывающий код не мог взять одну
// компоненту вместо другой (именно так раньше терялась комиссия биржи).
const buildWithdrawalFees = ({ amount, withdrawalFee, paidNetworkFee }) => {
	const networkFee = estimateNetworkFee(amount);
	const exchangeFee = toFee(withdrawalFee);

	// Если узел сообщил фактическую комиссию, она заменяет оценку — и только её.
	const settledNetworkFee = paidNetworkFee === undefined || paidNetworkFee === null
		? networkFee
		: toFee(paidNetworkFee);
	const networkDelta = settledNetworkFee - networkFee;

	return {
		amount,
		networkFee,
		exchangeFee,
		// С пользователя: выплата плюс ОДНА комиссия — тариф биржи.
		userDebit: amount + exchangeFee,
		// С hot wallet: только то, что физически уходит в сеть.
		hotDebit: amount + networkFee,
		// Фактическая сетевая комиссия и её отклонение от оценки: сверяется с
		// hot-флотом (биржа платит сеть из тарифа, поэтому пользователь тут не
		// участвует, а узел дебетуется ровно на фактический отток).
		settledNetworkFee,
		networkDelta,
		// Ответ API/журнала: что реально списано с пользователя.
		chargedToUser: amount + exchangeFee,
		// fee_ledger: начисленный доход биржи и фактический сетевой расход.
		exchangeIncome: exchangeFee,
		networkExpense: settledNetworkFee
	};
};

module.exports = {
	COIN_SYMBOL,
	MIN_NETWORK_FEE,
	estimateNetworkFee,
	computeExchangeFee,
	buildWithdrawalFees
};
