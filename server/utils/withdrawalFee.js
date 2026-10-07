'use strict';

// Комиссии LBTC-вывода: одна формула, одно место.
//
// Раньше эти величины считались прямо в performWithdrawal, а `fee` в записи
// withdrawals перезаписывался фактической сетевой комиссией. Из-за этого
// `coins.withdrawal_fee` — цитата, которую GET /withdrawal/fee/:currency уже
// показывал пользователю — никогда не списывался.
//
// Разделение принципиально:
//   * сеть  — реальный отток: получателю уходит amount, майнеру networkFee;
//   * биржа — наша комиссия, она никуда не уходит с узла, поэтому с hot wallet
//     её не берём: иначе флоат биржи сожмется на монеты, которые всё ещё
//     лежат в её кошельке.
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

// Собирает все величины проводки сразу, чтобы вызывающий код не мог взять одну
// компоненту вместо другой (именно так раньше терялась комиссия биржи).
const buildWithdrawalFees = ({ amount, withdrawalFee, paidNetworkFee }) => {
	const networkFee = estimateNetworkFee(amount);
	const exchangeFee = toFee(withdrawalFee);
	const totalFee = networkFee + exchangeFee;

	// Если узел сообщил фактическую комиссию, она заменяет оценку — и только её.
	const settledNetworkFee = paidNetworkFee === undefined || paidNetworkFee === null
		? networkFee
		: toFee(paidNetworkFee);
	const settledTotalFee = settledNetworkFee + exchangeFee;

	const networkDelta = settledNetworkFee - networkFee;

	return {
		amount,
		networkFee,
		exchangeFee,
		totalFee,
		settledNetworkFee,
		settledTotalFee,
		networkDelta,
		// С пользователя: выплата + обе комиссии.
		userDebit: amount + totalFee,
		// С hot wallet: только то, что физически уходит в сеть.
		hotDebit: amount + networkFee,
		// Ответ API/журнала: что реально списано с пользователя.
		chargedToUser: amount + settledTotalFee
	};
};

module.exports = {
	COIN_SYMBOL,
	MIN_NETWORK_FEE,
	estimateNetworkFee,
	buildWithdrawalFees
};
