'use strict';

// Локальная обработка выводов RVN — зеркало scripts/rvn-withdraw.js, но для
// вызова из API-контроллера. Облачный HollaEx API не знает RVN (локальная
// монета), поэтому вывод идёт через legacycoreagent → нода rvn-core.
//
// Возвращает { transaction_id, fee, network_fee, exchange_fee } — как
// toolsLib.wallet.performWithdrawal, чтобы контроллер мог отдать тот же ответ.

const http = require('http');
const { sequelize } = require('../db/models');
const { QueryTypes } = require('sequelize');

const CURRENCY = 'rvn';
const HOT_ADDRESS = process.env.RVN_HOT_ADDRESS || 'RJyxEWsm4wSu9xnV7AWKBwMiieNDUghcUX';
const AGENT_HOST = process.env.RVN_AGENT_HOST || process.env.LBTC_AGENT_HOST || 'host.docker.internal';
const AGENT_PORT = parseInt(process.env.RVN_AGENT_PORT || process.env.LBTC_AGENT_PORT || '8444', 10);
const AGENT_KEY = process.env.RVN_AGENT_API_KEY || process.env.LBTC_AGENT_API_KEY || '';

const BASE = 1e8;

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
		req.on('error', (e) => reject(new Error(`agent unreachable: ${e.message}`)));
		if (payload) req.write(payload);
		req.end();
	});
}

async function processWithdrawal(userId, address, amount, exchangeFee = 0) {
	const amountNum = Number(amount);
	const exchangeFeeNum = Number(exchangeFee) || 0;
	if (!(amountNum > 0)) throw new Error('amount must be positive');

	// 1. Отправка через агента (нода подписывает, ключей у нас нет).
	const { txid, fee: feeBase } = await agentCall('POST', '/api/chain/rvn/send', {
		from: HOT_ADDRESS,
		to: address,
		amount: Math.round(amountNum * BASE),
	});
	const networkFeeNum = (Number(feeBase) || 0) / BASE;
	const totalFee = networkFeeNum + exchangeFeeNum;

	// 2. Дебет баланса пользователя (amount + network fee + exchange fee).
	const upd = await sequelize.query(
		`UPDATE balances SET balance = balance - :total, available = available - :total, updated_at = NOW()
		 WHERE user_id = :userId AND currency = :currency AND (balance - :total) >= 0`,
		{ replacements: { total: amountNum + totalFee, userId, currency: CURRENCY }, type: QueryTypes.UPDATE }
	);
	// sequelize.query для UPDATE возвращает [rows, rowCount] (rowCount — число, не объект)
	const rowCount = (typeof upd[1] === 'number') ? upd[1] : (upd[1] && upd[1].rowCount) || 0;
	if (rowCount !== 1) {
		throw new Error(`balance debit for user ${userId} touched ${rowCount} rows, expected 1 (need ${amountNum + totalFee} RVN)`);
	}

	// 3. Запись транзакции.
	await sequelize.query(
		`INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
		 VALUES (:userId, 'withdrawal', :amount, :currency, 'completed', :fee, :currency, 'On-chain RVN withdrawal', NULL, :txid, :address, 'rvn', '{}', NOW(), NOW())`,
		{ replacements: { userId, amount: amountNum, currency: CURRENCY, fee: totalFee, txid, address }, type: QueryTypes.INSERT }
	);

	return {
		transaction_id: txid,
		fee: totalFee,
		network_fee: networkFeeNum,
		exchange_fee: exchangeFeeNum
	};
}

module.exports = { processWithdrawal };