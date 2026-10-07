'use strict';

const { SERVER_PATH } = require('../constants');
const { sendEmail } = require(`${SERVER_PATH}/mail`);
const { MAILTYPE } = require(`${SERVER_PATH}/mail/strings`);
const { WITHDRAWALS_REQUEST_KEY } = require(`${SERVER_PATH}/constants`);
const { verifyOtpBeforeAction } = require('./security');
const { subscribedToCoin, getKitCoin, getKitSecrets, getKitConfig } = require('./common');
const {
	INVALID_OTP_CODE,
	INVALID_WITHDRAWAL_TOKEN,
	EXPIRED_WITHDRAWAL_TOKEN,
	INVALID_COIN,
	INVALID_AMOUNT,
	DEPOSIT_DISABLED_FOR_COIN,
	WITHDRAWAL_DISABLED_FOR_COIN,
	UPGRADE_VERIFICATION_LEVEL,
	NO_DATA_FOR_CSV,
	USER_NOT_FOUND,
	USER_NOT_REGISTERED_ON_NETWORK,
	INVALID_NETWORK,
	NETWORK_REQUIRED,
	WITHDRAWAL_DISABLED,
	WITHDRAWAL_OTP_REQUIRED
} = require(`${SERVER_PATH}/messages`);
const { getUserByKitId, mapNetworkIdToKitId, mapKitIdToNetworkId } = require('./user');
const { findTransactionLimitPerTier } = require('./tier');
const { client } = require('./database/redis');
const crypto = require('crypto');
const uuid = require('uuid/v4');
const { all, reject } = require('bluebird');
const { getNodeLib } = require(`${SERVER_PATH}/init`);
const moment = require('moment');
const math = require('mathjs');
const { parse } = require('json2csv');
const { has } = require('lodash');
const WAValidator = require('multicoin-address-validator');
const { isEmail } = require('validator');
const BigNumber = require('bignumber.js');

const isValidAddress = (currency, address, network) => {
	if (address.indexOf('://') > -1) {
		return false;
	}
	if (network === 'eth' || network === 'ethereum') {
		return WAValidator.validate(address, 'eth');
	} else if (network === 'stellar' || network === 'xlm') {
		return WAValidator.validate(address.split(':')[0], 'xlm');
	} else if (network === 'tron' || network === 'trx') {
		return WAValidator.validate(address, 'trx');
	} else if (network === 'bsc' || currency === 'bnb' || network === 'bnb') {
		return WAValidator.validate(address, 'eth');
	} else if (currency === 'btc' || currency === 'bch' || currency === 'xmr') {
		return WAValidator.validate(address, currency);
	} else if (currency === 'xrp') {
		return WAValidator.validate(address.split(':')[0], currency);
	} else if (currency === 'etn' || currency === 'ton' || currency === 'sui') {
		// skip the validation
		return true;
	} else {
		const supported = WAValidator.findCurrency(currency);
		if (supported) {
			return WAValidator.validate(address, currency);
		} else {
			return true;
		}
	}
};

const getWithdrawalFee = (currency, network, amount, level) => {
	if (!subscribedToCoin(currency)) {
		return reject(new Error(INVALID_COIN(currency)));
	}

	const coinConfiguration = getKitCoin(currency);

	let fee = coinConfiguration.withdrawal_fee;
	let fee_coin = currency;

	if (network && coinConfiguration.withdrawal_fees && coinConfiguration.withdrawal_fees[network]) {
		fee = coinConfiguration.withdrawal_fees[network].value;
		fee_coin = coinConfiguration.withdrawal_fees[network].symbol;
	}

	// withdrawal fee calculation for fiat
	if (network === 'fiat') {
		if (coinConfiguration.withdrawal_fees && coinConfiguration.withdrawal_fees[currency]) {
			let value = coinConfiguration.withdrawal_fees[currency].value;
			fee_coin =  coinConfiguration.withdrawal_fees[currency].symbol;
			fee = value;
		}

		const customFee = getKitConfig()?.fiat_fees?.[currency]?.withdrawal_fee;
		if (customFee) {
			fee_coin = currency;
			fee = customFee;
		}

	}

	if (network === 'email') {
		fee = 0;
	}

	return { fee, fee_coin };
};

const findLimit = (limits = [], currency) => {

	const independentLimit = limits.find(limit => limit.limit_currency === currency);
	const defaultLimit = limits.find(limit => limit.limit_currency === 'default');

	return independentLimit || defaultLimit;
};



const sendRequestWithdrawalEmail = (user_id, address, amount, currency, version, opts = {
	network: null,
	otpCode: null,
	fee: null,
	fee_coin: null,
	skipValidate: false, // should be used with care if set to true
	ip: null,
	domain: null
}) => {
	let fee = opts.fee;
	let fee_coin = opts.fee_coin;
	let fee_markup;

	return verifyOtpBeforeAction(user_id, opts.otpCode)
		.then((validOtp) => {
			if (!validOtp) {
				throw new Error(INVALID_OTP_CODE);
			}
			return getUserByKitId(user_id);
		})
		.then(async (user) => {
			if (!opts.skipValidate) {
				const withdrawal = await validateWithdrawal(user, address, amount, currency, opts.network);
				fee = withdrawal.fee;
				fee_coin = withdrawal.fee_coin;
				fee_markup =  withdrawal.fee_markup;
			}
			

			return withdrawalRequestEmail(
				user,
				{
					user_id,
					email: user.email,
					amount,
					fee,
					fee_coin,
					fee_markup,
					transaction_id: uuid(),
					address,
					currency,
					network: opts.network
				},
				opts.domain,
				opts.ip,
				version
			);
		});
};

const withdrawalRequestEmail = async (user, data, domain, ip, version) => {
	data.timestamp = Date.now();
	let stringData = JSON.stringify(data);
	let token;

	if (version === 'v3') {
		const letters = Array.from({ length: 2 }, () =>
			String.fromCharCode(65 + crypto.randomInt(0, 26))
		).join('');
		const numbers = Math.floor(10000 + Math.random() * 90000);
		token = `${letters}-${numbers}`;
	} else {
		token = data.transaction_id || crypto.randomBytes(60).toString('hex');
	}

	await client.hsetAsync(WITHDRAWALS_REQUEST_KEY, token, stringData);
		
	await client.setexAsync(
		`user:freeze-account:${token}`,
		60 * 60 * 6,
		JSON.stringify({
			id: token,
			user_id: user.id,
			email: user.email,
			verification_code: token,
			ip,
			time: new Date().toISOString()
		})
	);

	const { email, amount, fee, fee_coin, fee_markup, currency, address, network } = data;
	sendEmail(
		version === 'v3' ? MAILTYPE.WITHDRAWAL_REQUEST_CODE : MAILTYPE.WITHDRAWAL_REQUEST,
		email,
		{
			amount,
			fee,
			fee_markup,
			fee_coin: fee_coin,
			currency: currency,
			transaction_id: token,
			address,
			ip,
			network,
			freeze_account_link: `${domain}/confirm-login?token=${token}&prompt=false&freeze_account=true`
		},
		user.settings,
		domain
	);
	return data;
};

const validateWithdrawalToken = (token) => {
	return client.hgetAsync(WITHDRAWALS_REQUEST_KEY, token)
		.then((withdrawal) => {
			if (!withdrawal) {
				throw new Error(INVALID_WITHDRAWAL_TOKEN);
			} else {
				withdrawal = JSON.parse(withdrawal);

				client.hdelAsync(WITHDRAWALS_REQUEST_KEY, token);

				if (Date.now() - withdrawal.timestamp > getKitSecrets().security.withdrawal_token_expiry) {
					throw new Error(EXPIRED_WITHDRAWAL_TOKEN);
				} else {
					return withdrawal;
				}
			}
		});
};

const cancelUserWithdrawalByKitId = async (userId, withdrawalId, opts = {
	additionalHeaders: null
}) => {
	// check mapKitIdToNetworkId
	const idDictionary = await mapKitIdToNetworkId([userId]);

	if (!has(idDictionary, userId)) {
		throw new Error(USER_NOT_FOUND);
	} else if (!idDictionary[userId]) {
		throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	}
	return getNodeLib().cancelWithdrawal(idDictionary[userId], withdrawalId, opts);
};

const cancelUserWithdrawalByNetworkId = (networkId, withdrawalId, opts = {
	additionalHeaders: null
}) => {
	if (!networkId) {
		return reject(new Error(USER_NOT_REGISTERED_ON_NETWORK));
	}
	return getNodeLib().cancelWithdrawal(networkId, withdrawalId, opts);
};

const checkTransaction = (currency, transactionId, address, network, isTestnet = false, opts = {
	additionalHeaders: null
}) => {
	if (!subscribedToCoin(currency)) {
		return reject(new Error(INVALID_COIN(currency)));
	}

	return getNodeLib().checkTransaction(currency, transactionId, address, network, { isTestnet, ...opts });
};

const { estimateNetworkFee, buildWithdrawalFees, COIN_SYMBOL } = require('../../withdrawalFee');

const performWithdrawal = async (userId, address, currency, amount, opts = {
	network: null,
	fee_markup: null,
	additionalHeaders: null
}) => {
	// LBTC: withdrawal through the node-wallet agent (before subscribedToCoin check)
	if (currency === 'lbtc') {
		const { Client } = require('pg');
		const http = require('http');

		// The node owns the operational float and is the only signer of record for
		// it: these addresses have no extractable key (dumpprivkey answers "address
		// not found") and the external signer demands a privateKey we cannot obtain
		// for them. So the engine no longer reads a wallet file, links a signing
		// library or talks to the node RPC: it asks the agent, and the agent lets
		// the node's own wallet pay. The node picks the source UTXOs, because its
		// sendtoaddress takes no from-address, so the debit lands on the wallet as
		// a whole rather than on the labelled hot address.
		const AGENT_HOST = process.env.LBTC_AGENT_HOST || 'host.docker.internal';
		const AGENT_PORT = parseInt(process.env.LBTC_AGENT_PORT) || 8444;
		const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || '';
		const HOT_WALLET_ADDR = process.env.LBTC_HOT_ADDRESS || 'LSDpPPpUaNNV4B5TbmJgY9tR8gfxpaECvH';
		const HOT_WALLET_USER_ID = 1;

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
						try { json = JSON.parse(data); }
						catch (e) { return reject(new Error(`agent: unparsable reply: ${data.slice(0, 200)}`)); }
						if (json.error) return reject(new Error(`agent: ${json.error}`));
						resolve(json.result !== undefined ? json.result : json);
					});
				});
				req.on('error', (e) => reject(new Error(`agent unreachable at ${AGENT_HOST}:${AGENT_PORT}: ${e.message}`)));
				if (payload) req.write(payload);
				req.end();
			});
		}

		// Relay floor on this node is 1000 base units per KB, i.e. 0.00001 LBTC/KB.
		// The node chooses the inputs, so the final size is not knowable up front:
		// assume ~40 LBTC per UTXO (the wallet's denominations top out near 50) and
		// ~148 bytes per input, then take 4x the floor so the node cannot reject us
		// for under-paying. A single hardcoded fee is what made the 7 500 LBTC
		// funding fail with "insufficient fee" once the tx reached 32 KB.
		const networkFee = estimateNetworkFee(amount);

		// Refuse an unusable destination before any balance is touched.
		const vinfo = await agentCall('GET', `/api/chain/lbtc/validate/${encodeURIComponent(address)}`);
		if (!vinfo || vinfo.isvalid !== true) throw new Error(`invalid LBTC destination address: ${address}`);

		const db = new Client({
			host: process.env.DB_HOST || '127.0.0.1',
			port: parseInt(process.env.DB_PORT) || 5432,
			database: process.env.DB_NAME || 'hollaex',
			user: process.env.DB_USER || process.env.DB_USERNAME || 'admin',
			password: process.env.DB_PASS || process.env.DB_PASSWORD || 'root',
		});
		await db.connect();

		const isHot = userId === HOT_WALLET_USER_ID;

		// withdrawals.coin_id is NOT NULL and the fx_withdrawal_guard trigger reads
		// it to resolve the symbol, so the id has to come from the table rather than
		// being assumed. withdrawal_fee comes from the same row: it is the exchange's
		// own commission and is what GET /withdrawal/fee/:currency already quotes to
		// the user, so charging exactly it here is what makes that quote true.
		const coinRow = await db.query(
			`SELECT id, COALESCE(withdrawal_fee, 0) AS withdrawal_fee, withdrawal_fees
			   FROM coins WHERE symbol = $1 LIMIT 1`,
			[COIN_SYMBOL]
		);
		if (!coinRow.rows.length) {
			await db.end().catch(() => {});
			throw new Error('lbtc coin row is missing from coins');
		}
		const coinId = coinRow.rows[0].id;
		let exchangeFee = Number(coinRow.rows[0].withdrawal_fee) || 0;
		try {
			const wf = coinRow.rows[0].withdrawal_fees;
			if (wf && typeof wf === 'object') {
				const cfg = wf[COIN_SYMBOL] || wf['lbtc'] || null;
				if (cfg && cfg.type === 'percent' && cfg.value) {
					exchangeFee = (amount * Number(cfg.value)) / 100;
				}
			}
		} catch (e) {}
		const { userDebit, hotDebit } = buildWithdrawalFees({
			amount,
			withdrawalFee: exchangeFee
		});

		// userDebit снимает с пользователя обе комиссии, hotDebit — только сетевую.
		// Формула живёт в utils/withdrawalFee.js, чтобы её нельзя было собрать
		// заново и потерять одну из компонент.

		// Reserve in the ledger before broadcasting, and verify the reservation
		// actually happened. The previous code issued this UPDATE and discarded
		// rowCount, so a user without funds still reached the broadcast: coins left
		// the exchange with nothing debited. The rowCount check is the guard.
		//
		// The withdrawals row is written in the same transaction, BEFORE the debit,
		// and that order is load-bearing:
		//   - fx_withdrawal_guard_trg reads balances.available, so it must see the
		//     pre-debit figure. Inserting after the UPDATE would make a full-balance
		//     withdrawal look like an overdraft and raise spuriously.
		//   - the trigger enforces the single/monthly/KYC limits in fx_risk_limits
		//     and the order-lock coverage check. A withdrawal that never reaches
		//     `withdrawals` is invisible to all of them, which is how every LBTC
		//     payout so far skipped the limits entirely.
		//   - /user/withdrawals reads `withdrawals`, not `transactions`, so without
		//     this row the payout is debited but never appears in the user's history.
		let withdrawalId = null;
		try {
			await db.query('BEGIN');
			// FOR UPDATE serialises concurrent withdrawals on the same rows so two
			// of them cannot both pass the balance check. This is the in-transaction
			// guard; a durable withdrawal_reserve is still the proper fix.
			const locked = await db.query(
				`SELECT user_id, balance FROM balances
				  WHERE currency = 'lbtc' AND user_id = ANY($1::int[]) FOR UPDATE`,
				[[HOT_WALLET_USER_ID, userId]]
			);
			const bal = {};
			for (const row of locked.rows) bal[row.user_id] = Number(row.balance);

			if (bal[userId] === undefined) throw new Error(`user ${userId} has no lbtc balance row`);
			if (bal[userId] < userDebit) {
				throw new Error(`insufficient LBTC balance for user ${userId}: have ${bal[userId]}, need ${userDebit}`);
			}
			if (!isHot) {
				if (bal[HOT_WALLET_USER_ID] === undefined || bal[HOT_WALLET_USER_ID] < hotDebit) {
					throw new Error(`hot wallet (user ${HOT_WALLET_USER_ID}) cannot cover ${hotDebit}, has ${bal[HOT_WALLET_USER_ID]}`);
				}
			}

			let inserted;
			try {
				inserted = await db.query(
					`INSERT INTO withdrawals
						(user_id, coin_id, amount, status, address, fee, network_fee, exchange_fee, created_at, updated_at)
					 VALUES ($1::int, $2::int, $3::numeric, 'processing', $4,
					         $5::numeric, $6::numeric, $7::numeric, NOW(), NOW())
					 RETURNING id`,
					[userId, coinId, amount, address, networkFee + exchangeFee, networkFee, exchangeFee]
				);
			} catch (insErr) {
				// fx_withdrawal_guard raises 23514 with a 'withdrawal blocked: <reason>'
				// message. That text is the risk-limit verdict, not an internal fault,
				// so tag it as such rather than letting it surface as a 500-looking
				// database error. The whole reason this row exists is so that verdict
				// is reachable.
				if (insErr.code === '23514' && /withdrawal blocked/.test(insErr.message || '')) {
					const blocked = new Error(insErr.message);
					blocked.riskPolicy = true;
					throw blocked;
				}
				throw insErr;
			}
			withdrawalId = inserted.rows[0].id;

			for (const [uid, delta] of (isHot ? [[userId, userDebit]] : [[userId, userDebit], [HOT_WALLET_USER_ID, hotDebit]])) {
				const r = await db.query(
					`UPDATE balances SET balance = balance - $1::numeric, available = available - $1::numeric, updated_at = NOW()
					  WHERE user_id = $2::int AND currency = 'lbtc'`,
					[delta, uid]
				);
				if (r.rowCount !== 1) throw new Error(`debit of user ${uid} touched ${r.rowCount} rows, expected 1`);
			}
			await db.query('COMMIT');
		} catch (err) {
			await db.query('ROLLBACK').catch(() => {});
			await db.end().catch(() => {});
			throw err;
		}

		// Ledger is reserved; now broadcast. If the node refuses, release the
		// reservation, otherwise the user is charged for a transfer that never
		// happened.
		let txid, paidFee = networkFee;
		try {
			const sres = await agentCall('POST', '/api/chain/lbtc/send', {
				from: HOT_WALLET_ADDR,
				to: address,
				amount: Math.round(amount * 1e8),
				fee: Math.round(networkFee * 1e8),
			});
			txid = sres && (sres.txid || sres.tx_id);
			if (!txid) throw new Error(`agent send returned no txid: ${JSON.stringify(sres).slice(0, 200)}`);
			// The node reports the fee it really paid, in base units. We passed an
			// explicit fee and it should honour that exactly, but record what the
			// chain says so the ledger cannot drift from the transaction. Only the
			// network component is settled against the chain; the exchange fee is
			// ours and the chain has no opinion on it.
			if (sres.fee !== undefined && Number(sres.fee) !== Math.round(networkFee * 1e8)) {
				console.warn(`[lbtc] node charged ${Number(sres.fee) / 1e8} LBTC, ledger reserved ${networkFee} LBTC for ${txid}`);
			}
			paidFee = sres.fee !== undefined ? Number(sres.fee) / 1e8 : networkFee;
		} catch (err) {
			// The chain refused, so the reservation is void: give the money back and
			// close the row. Leaving it at 'processing' would keep the amount
			// counted against the monthly cap for a transfer that never happened.
			await db.query('BEGIN').catch(() => {});
			for (const [uid, delta] of (isHot ? [[userId, userDebit]] : [[userId, userDebit], [HOT_WALLET_USER_ID, hotDebit]])) {
				await db.query(
					`UPDATE balances SET balance = balance + $1::numeric, available = available + $1::numeric, updated_at = NOW()
					  WHERE user_id = $2::int AND currency = 'lbtc'`,
					[delta, uid]
				).catch(() => {});
			}
			if (withdrawalId) {
				await db.query(
					`UPDATE withdrawals SET status = 'failed', updated_at = NOW() WHERE id = $1::int`,
					[withdrawalId]
				).catch(() => {});
			}
			await db.query('COMMIT').catch(() => {});
			await db.end().catch(() => {});
			throw err;
		}

		// The chain accepted the transfer. From here the coins are gone whatever the
		// ledger does, so the write must be retried rather than surfaced as a failed
		// withdrawal — telling the user "error" would invite a second payout.
		let ledgerErr = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				await db.query('BEGIN');
				// The reservation debited `amount + networkFee + exchangeFee`; the
				// chain actually charged `amount + paidFee`. Settle the network
				// difference in the same transaction so the ledger ends on the real
				// figure instead of silently keeping whatever we guessed. The
				// exchange fee is deliberately not part of this settlement: it was
				// never a chain cost, so the chain cannot under- or over-charge it.
				// Underpay returns coins to the user, overpay takes them — an overpay
				// can push a balance negative, which is recorded rather than refused,
				// because refusing here would leave the ledger describing a
				// transaction the chain already settled.
				const feeDelta = buildWithdrawalFees({
					amount,
					withdrawalFee: exchangeFee,
					paidNetworkFee: paidFee
				}).networkDelta;
				if (feeDelta !== 0) {
					for (const uid of isHot ? [userId] : [userId, HOT_WALLET_USER_ID]) {
						const r = await db.query(
							`UPDATE balances SET balance = balance - $1::numeric, available = available - $1::numeric, updated_at = NOW()
							  WHERE user_id = $2::int AND currency = 'lbtc'`,
							[feeDelta, uid]
						);
						if (r.rowCount !== 1) throw new Error(`fee settlement of user ${uid} touched ${r.rowCount} rows, expected 1`);
					}
				}
				await db.query(
					`UPDATE withdrawals
					    SET status = 'completed',
					    tx_hash = $2,
					    network_fee = $3::numeric,
					    fee = $3::numeric + $4::numeric,
					    updated_at = NOW()
					  WHERE id = $1::int`,
					[withdrawalId, txid, paidFee, exchangeFee]
				);
				await db.query(
					`INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, tx_hash, address, network, metadata, created_at, updated_at)
					 VALUES ($1::int, 'withdrawal', $2::numeric, 'lbtc', 'completed', $3::numeric, 'lbtc', 'On-chain LBTC withdrawal', $4, $5, 'lbtc', '{}', NOW(), NOW())`,
					[userId, amount, paidFee + exchangeFee, txid, address]
				);
				// Deliberately no balances -> user_wallets mirror here. That mirror wrote
				// a user's entire wallet set to one value, and on 2026-09-27 it stamped
				// every operational address of user 1 with 7499.99, which no single
				// address held. user_wallets.balance is the on-chain balance of one
				// address and may only be written from chain data, which is the deposit
				// monitor's job. The node wallet total is the authoritative float.
				await db.query('COMMIT');
				ledgerErr = null;
				break;
			} catch (e) {
				ledgerErr = e;
				await db.query('ROLLBACK').catch(() => {});
				console.error(`[lbtc] ledger write attempt ${attempt}/3 failed for ${txid}:`, e.message);
				await new Promise((r) => setTimeout(r, 250 * attempt));
			}
		}
		await db.end().catch(() => {});
		if (ledgerErr) {
			// Do not throw: the payout is on chain. The withdrawal row is still
			// 'processing', which is how an operator spots it and reconciles.
			console.error(
				`[lbtc] CRITICAL: ${txid} was broadcast but not recorded. user=${userId} amount=${amount} fee=${paidFee} — reconcile withdrawals #${withdrawalId}`
			);
		}

		// `fee` is what the user was actually charged, so the success response
		// cannot quietly under-report it: the controller passes this straight
		// back to the client, and returning the network fee alone would tell
		// them 0.0002 after debiting 0.0102 — and would contradict the 0.01 that
		// GET /withdrawal/fee/lbtc already quoted. The breakdown rides along so
		// the UI can show where the fee went.
		const settled = buildWithdrawalFees({
			amount,
			withdrawalFee: exchangeFee,
			paidNetworkFee: paidFee
		});
		return {
			transaction_id: txid,
			fee: settled.settledTotalFee,
			network_fee: settled.settledNetworkFee,
			exchange_fee: settled.exchangeFee
		};
	}

	// Non-LBTC: delegate to network (original flow)
	if (!subscribedToCoin(currency)) throw new Error(INVALID_COIN(currency));
	const user = await getUserByKitId(userId);
	if (!user) throw new Error(USER_NOT_FOUND);
	if (!user.network_id) throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	return getNodeLib().performWithdrawal(user.network_id, address, currency, amount, opts);
};

async function performDirectWithdrawal(userId, address, currency, amount, opts = {
	network: null,
	additionalHeaders: null
}) {
	const user = await getUserByKitId(userId);
	await validateWithdrawal(user, address, amount, currency, opts.network);
	// LBTC: reuse the same local withdrawal logic
	return await performWithdrawal(userId, address, currency, amount, opts);
}

const performWithdrawalNetwork = (networkId, address, currency, amount, opts = {
	network: null,
	additionalHeaders: null
}) => {
	return getNodeLib().performWithdrawal(networkId, address, currency, amount, opts);
};

const calculateWithdrawalMax = async (user_id, currency, selectedNetwork) => {
	if (!subscribedToCoin(currency)) {
		throw new Error('Invalid coin ' + currency);
	}

	const user = await getUserByKitId(user_id);
	const balance = await getNodeLib().getUserBalance(user.id);
	let amount = balance[`${currency}_available`];

	if (amount === 0) return { amount };

	const coinConfiguration = getKitCoin(currency);
	const coinMarkup = getKitConfig()?.coin_customizations?.[currency];
	const { fee, fee_coin } = getWithdrawalFee(currency, selectedNetwork, amount, user.verification_level);
	const { increment_unit } = coinConfiguration;


	const transactionLimits = await findTransactionLimitPerTier(user.verification_level, 'withdrawal');
	const transactionLimit = findLimit(transactionLimits, currency);

	if (!transactionLimit) {
		throw new Error('There is no limit rule defined for the currency ', + currency);
	}

	if (transactionLimit.amount === -1) throw new Error(WITHDRAWAL_DISABLED_FOR_COIN(currency));
	if (transactionLimit?.monthly_amount === -1) throw new Error(WITHDRAWAL_DISABLED_FOR_COIN(currency));

	if (transactionLimit.amount > 0) {

		let amountMultiplier = 1;

		if (currency !== transactionLimit.currency) {
			const convertedWithdrawalAmount = await getNodeLib().getOraclePrices([transactionLimit.currency], {
				quote: currency,
				amount: 1
			});

			if (convertedWithdrawalAmount[transactionLimit.currency] === -1) {
				throw new Error(`No conversion found between ${currency} and ${transactionLimit.currency}`);
			}

			if (convertedWithdrawalAmount[transactionLimit.currency]) 
				amountMultiplier = new BigNumber(convertedWithdrawalAmount[transactionLimit.currency]).toNumber();
		}


		const withdrawalHistory = await withdrawalBelowLimit(user.network_id, currency, amount, transactionLimits, false);
		const convertedLast24Amount =  (amountMultiplier * withdrawalHistory?.withdrawalAmount24Hours) || 0;
		const convertedLastMonthAmount =  (amountMultiplier * withdrawalHistory?.withdrawalAmountLastMonth) || 0;

		const dailyAmount = amountMultiplier * transactionLimit.amount;
		const monthlyAmount = amountMultiplier * (transactionLimit.monthly_amount || 0);


		const dailyWithdrawalLeft = new BigNumber(dailyAmount).minus(new BigNumber(convertedLast24Amount).plus(amount)).toNumber();
		const monthlyWithdrawalLeft = transactionLimit.monthly_amount > 0 ? new BigNumber(monthlyAmount).minus(new BigNumber(convertedLastMonthAmount).plus(amount)).toNumber() : 0;

		const amountToSubtract = monthlyWithdrawalLeft < dailyWithdrawalLeft ? monthlyWithdrawalLeft : dailyWithdrawalLeft;
		if (amountToSubtract < 0) {
			amount = new BigNumber(amount).minus(new BigNumber(amountToSubtract).absoluteValue()).toNumber();
		}
		
		if (fee_coin && fee_coin === currency
			&& new BigNumber(amount).plus(new BigNumber(fee)).comparedTo(balance[`${currency}_available`]) === 1
		) {

			amount = new BigNumber(balance[`${currency}_available`]).minus(new BigNumber(fee)).toNumber();

			if (selectedNetwork !== 'email' && coinMarkup?.fee_markups?.[selectedNetwork]?.withdrawal?.value && coinMarkup?.fee_markups?.[selectedNetwork]?.withdrawal?.symbol === fee_coin) {
				amount = new BigNumber(amount).minus(new BigNumber(coinMarkup.fee_markups[selectedNetwork].withdrawal?.value)).toNumber();
			}
		}

		amount = BigNumber.minimum(dailyAmount, amount).toNumber();
	}

	if (amount < 0) {
		amount = 0;
	}

	const decimalPoint = new BigNumber(increment_unit).dp();
	amount = new BigNumber(amount).decimalPlaces(decimalPoint, BigNumber.ROUND_DOWN).toNumber();
	return { amount };
};

const validateWithdrawal = async (user, address, amount, currency, network = null) => {
	const coinConfiguration = getKitCoin(currency);
	const coinMarkup = getKitConfig()?.coin_customizations?.[currency];
	if (!subscribedToCoin(currency)) {
		throw new Error(INVALID_COIN(currency));
	}

	if (amount <= 0) {
		throw new Error(INVALID_AMOUNT(amount));
	}

	if (!coinConfiguration.allow_withdrawal) {
		throw new Error(WITHDRAWAL_DISABLED_FOR_COIN(currency));
	}

	if (network === 'email') {
		// internal email transfer
		if (!isEmail(address)) {
			throw new Error(`Invalid ${currency} address: ${address}`);
		}
	} else if (network !== 'fiat') {
		// blockchain transfer
		if (coinConfiguration.network) {
			if (!network) {
				throw new Error(NETWORK_REQUIRED(currency, coinConfiguration.network));
			} else if (!coinConfiguration.network.split(',').includes(network)) {
				throw new Error(INVALID_NETWORK(network, coinConfiguration.network));
			}
		} else if (network)  {
			throw new Error(`Invalid ${currency} network given: ${network}`);
		}
		if (!isValidAddress(currency, address, network)) {
			throw new Error(`Invalid ${currency} address: ${address}`);
		}
	}

	if (!user) {
		throw new Error(USER_NOT_FOUND);
	} else if (currency !== 'lbtc' && !user.network_id) {
		throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	} else if (user.verification_level < 1) {
		throw new Error(UPGRADE_VERIFICATION_LEVEL(1));
	} else if (user.is_subaccount) {
		throw new Error(WITHDRAWAL_DISABLED);
	} else if(user.withdrawal_blocked && moment().isBefore(moment(user.withdrawal_blocked))) {
		throw new Error(WITHDRAWAL_DISABLED);	
	}

	// Enforce 2FA for withdrawals when feature flag is enabled
	const requireOtp = getKitConfig()?.force_two_factor_authentication_withdrawal?.active;
	if (requireOtp && !user.otp_enabled) {
		throw new Error(WITHDRAWAL_OTP_REQUIRED);
	}

	let { fee, fee_coin } = getWithdrawalFee(currency, network, amount, user.verification_level);

	// Balance table stores kit user_id (not network_id)
	const balanceUserId = user.id;
	const balance = await getNodeLib().getUserBalance(balanceUserId);

	if (coinMarkup?.fee_markups?.[network]?.withdrawal?.value && coinMarkup?.fee_markups?.[network]?.withdrawal?.symbol === fee_coin && network !== 'fiat' && network !== 'email') {
		fee = math.number(math.add(math.bignumber(fee), math.bignumber(coinMarkup.fee_markups[network].withdrawal?.value)));
	}
	
	if (fee_coin === currency) {
		const totalAmount =
			fee > 0
				? math.number(math.add(math.bignumber(fee), math.bignumber(amount)))
				: amount;

		if (math.compare(totalAmount, balance[`${currency}_available`]) === 1) {
			throw new Error(
				`User ${currency} balance is lower than amount "${amount}" + fee "${fee}"`
			);
		}
	} else {
		if (math.compare(amount, balance[`${currency}_available`]) === 1) {
			throw new Error(
				`User ${currency} balance is lower than withdrawal amount "${amount}"`
			);
		}

		if (math.compare(fee, balance[`${fee_coin}_available`]) === 1) {
			throw new Error(
				`User ${fee_coin} balance is lower than fee amount "${fee}"`
			);
		}
	}
	
	// Find All the transaction limit based on the tier level
	const transactionLimits = await findTransactionLimitPerTier(user.verification_level, 'withdrawal');
	await withdrawalBelowLimit(balanceUserId, currency, amount, transactionLimits);
	
	return {
		fee,
		fee_coin,
		...((coinMarkup?.fee_markups?.[network]?.withdrawal?.value && coinMarkup?.fee_markups?.[network]?.withdrawal?.symbol === fee_coin) && { fee_markup: coinMarkup.fee_markups[network].withdrawal?.value })
	};
};

const withdrawalBelowLimit = async (userId, currency, amount = 0, transactionLimits, throwError = true) => {

	/* 
		transaction limit data consists of 6 fields
		amount: limit amount for the transaction for last 24 hours e.g: 500
		monthly_amount: limit amount for the transaction for last month (Optional) e.g: 10000
		currency: this is the currency for the limit amounts, e.g: 500 XHT
		limit_currency: this is also currency field but it's different than "currency" field.
						limit_currency can eighter be default or a coin:
							If it's default then we will accumulate the past withdrawal amounts of all the coins
							If it's a coin, then we will only accumulate the past withdrawal amounts of of that coin
		type: withdrawal or deposit
	*/

	//Get the limit info based on the currency of the withdrawal
	//if there is no limit info based on the currency, get the default one
	const transactionLimit = findLimit(transactionLimits, currency);

	// If there is no record, prevent the withdrawal process
	if (!transactionLimit) {
		throw new Error(`There is no limit rule defined for the currency ${currency}`);
	}

	// amount and monthly amount fields of the limit info are our limits
	const last24HoursLimit = transactionLimit.amount;
	const lastMonthLimit = transactionLimit.monthly_amount;

	// if limit is -1 it means it's disabled
	if (last24HoursLimit === -1) throw new Error(WITHDRAWAL_DISABLED_FOR_COIN(currency));
	if (lastMonthLimit === -1) throw new Error(WITHDRAWAL_DISABLED_FOR_COIN(currency));
	// if limit is 0 it means it's limitless
	if (last24HoursLimit === 0 && lastMonthLimit === 0) return;

	// totalWithdrawalAmount will be compared to the set limit above
	// we initialize it with the amount we want to withdraw
	let totalWithdrawalAmount = new BigNumber(amount);

	// the currency defined in the limit info can be different than the currency we want to withdraw from
	// in this case we need to convert the amount inputted by user to the currency defined in the limit info
	if (currency !== transactionLimit.currency) {

		const convertedWithdrawalAmount = await getNodeLib().getOraclePrices([currency], {
			quote: transactionLimit.currency,
			amount
		});

		if (convertedWithdrawalAmount[currency] === -1) { 
			throw new Error(`No conversion found between ${currency} and ${transactionLimit.currency}`);
		}

		totalWithdrawalAmount = new BigNumber(convertedWithdrawalAmount[currency]);
	}

	// Get the individual coins from the transaction limit data, those will be excluded from aggregation
	const excludedCurrencies = transactionLimits.filter(limit => limit.limit_currency !== 'default' && limit.limit_currency !== currency).map(limit => limit.limit_currency);
	
	// Accumulate the past withdrawals
	const withdrawalAmount = await getAccumulatedWithdrawals(userId, transactionLimit, excludedCurrencies);

	// Add the accumulated withdrawal amount to totalWithdrawalAmount variable. We are now done with the calculations
	const totalWithdrawalAmount24Hours = totalWithdrawalAmount.plus(new BigNumber(withdrawalAmount['24h'] || 0)).toNumber();
	const totalWithdrawalAmountLastMonth = totalWithdrawalAmount.plus(new BigNumber(withdrawalAmount['1m'] || 0)).toNumber();

	// Compare the final amount the the limit defined in the limit info, if it exceeds the limit, we should not allow the withdrawal to happen
	if (last24HoursLimit > 0 && totalWithdrawalAmount24Hours > last24HoursLimit && throwError) {
		throw new Error(
			`Total withdrawn amount would exceed withdrawal limit of ${last24HoursLimit} ${transactionLimit.currency}. Last 24 hours withdrawn amount: ${totalWithdrawalAmount24Hours} ${transactionLimit.currency}. Request amount: ${amount} ${currency}`
		);
	}

	if (lastMonthLimit > 0 && totalWithdrawalAmountLastMonth > lastMonthLimit && throwError) {
		throw new Error(
			`Total withdrawn amount would exceed withdrawal limit of ${lastMonthLimit} ${transactionLimit.currency}. Last month withdrawn amount: ${totalWithdrawalAmountLastMonth} ${transactionLimit.currency}. Request amount: ${amount} ${currency}`
		);
	}

	return { totalWithdrawalAmount24Hours, totalWithdrawalAmountLastMonth, withdrawalAmount24Hours: withdrawalAmount['24h'], withdrawalAmountLastMonth: withdrawalAmount['1m'], last24HoursLimit, lastMonthLimit };
};

const getAccumulatedWithdrawals = async (userId, transactionLimit, excludedCurrencies = []) => {

	// if the limit currency in the limit info is default, it means that we want to fetch all the withdrawal records of all coins
	// if the limit currency in the limit info is a specific coin, it means we only want to fetch the withdrawal records of the coin
	const currency = transactionLimit.limit_currency === 'default' ? null : transactionLimit.limit_currency;

	const withdrawalHistory = {};

	const periods = [];
	if(transactionLimit?.amount > 0) periods.push('24h');
	if(transactionLimit?.monthly_amount > 0) periods.push('1m');

	const withdrawals = await getNodeLib().getUserWithdrawals(userId, {
		currency,
		dismissed: false,
		rejected: false,
		format: 'all',
		startDate: transactionLimit?.monthly_amount > 0 ? moment().subtract(1, 'months').toISOString() : moment().subtract(24, 'hours').toISOString()
	});

	for (const period of periods) {
	
		//Accumulate the amounts based on currency
		// If it's last month records, Extract the last 24 hours for daily limit calculation. 
		const withdrawalData = (transactionLimit?.monthly_amount > 0 && period === '24h')
			? (withdrawals.data || []).filter(withdrawal => moment(withdrawal.created_at) >= moment().subtract(24, 'hours')) 
			: withdrawals.data;
		
		const withdrawalAmount = {};
		for (let withdrawal of withdrawalData) {
			withdrawalAmount[withdrawal.currency] = new BigNumber(withdrawalAmount[withdrawal.currency] || 0).plus(withdrawal.amount).toNumber();
		}
	
		// if the limit currency in the limit info is a specific coin, we do not need to do accumulation based on all coins
		// in this case, We only want to fetch the accumulated amount of the specific coin
		if (currency && withdrawalAmount[currency]) { 
			withdrawalHistory[period] = withdrawalAmount[currency];
			continue;
		}

		let totalWithdrawalAmount = 0;

		const withdrawalCurrencies = Object.keys(withdrawalAmount || {});
		const convertedAmount = withdrawalCurrencies.length > 0 && await getNodeLib().getOraclePrices(withdrawalCurrencies, {
			quote: transactionLimit.currency,
			amount: 1
		});

		// if the limit currency in the limit info is default, we will run this loop to accumulate the withdrawal amounts of all coin
		// but since coins are different from each other, we will convert them to currency defined in the limit info and then accumulate them 
		for (const withdrawalCurrency of withdrawalCurrencies) {
			if (excludedCurrencies.indexOf(withdrawalCurrency) > -1) continue;
			if (!convertedAmount[withdrawalCurrency]) continue;
			if (convertedAmount[withdrawalCurrency] === -1) continue;

			const totalAmount = new BigNumber(withdrawalAmount[withdrawalCurrency]).multipliedBy(convertedAmount[withdrawalCurrency]);
		
			totalWithdrawalAmount = new BigNumber(totalWithdrawalAmount).plus(totalAmount).toNumber();
		}
	
		withdrawalHistory[period] = totalWithdrawalAmount;
	}
	
	return withdrawalHistory;
};

const transferAssetByKitIds = (senderId, receiverId, currency, amount, description = 'Admin Transfer', email = true, opts = {
	category: null,
	transactionId: null,
	additionalHeaders: null
}) => {
	if (!subscribedToCoin(currency)) {
		return reject(new Error(INVALID_COIN(currency)));
	}

	if (amount <= 0) {
		return reject(new Error(INVALID_AMOUNT(amount)));
	}

	return all([
		mapKitIdToNetworkId([senderId]),
		mapKitIdToNetworkId([receiverId])
	])
		.then(([ sender, receiver ]) => {
			if (!has(sender, senderId) || !has(receiver, receiverId)) {
				throw new Error(USER_NOT_FOUND);
			} else if (!sender[senderId] || !receiver[receiverId]) {
				throw new Error('User not registered on network');
			}
			return getNodeLib().transferAsset(sender[senderId], receiver[receiverId], currency, amount, { description, email, ...opts });
		});
};

const transferAssetByNetworkIds = (senderId, receiverId, currency, amount, description = 'Admin Transfer', email = true, opts = {
	transactionId: null,
	additionalHeaders: null
}) => {
	return getNodeLib().transferAsset(senderId, receiverId, currency, amount, { description, email, ...opts });
};

const getUserBalanceByKitId = async (userKitId, opts = {
	additionalHeaders: null
}) => {
	// Balance table stores kit user_id (not network_id)
	return getNodeLib().getUserBalance(userKitId, opts)
		.then((data) => {
			return {
				user_id: userKitId,
				...data
			};
		});
};

const getUserBalanceByNetworkId = async (networkId, opts = {
	additionalHeaders: null
}) => {
	if (!networkId) {
		return reject(new Error(USER_NOT_REGISTERED_ON_NETWORK));
	}
	// Local Balance table stores kit ids, so resolve network_id -> kit id
	const idDictionary = await mapNetworkIdToKitId([networkId]);
	const kitId = idDictionary[networkId];
	if (!kitId) {
		return reject(new Error(USER_NOT_FOUND));
	}
	return getNodeLib().getUserBalance(kitId, opts);
};

const getKitBalance = (opts = {
	additionalHeaders: null
}) => {
	return getNodeLib().getBalance(opts);
};

const getUserTransactionsByKitId = (
	type,
	kitId,
	currency,
	status,
	dismissed,
	rejected,
	processing,
	waiting,
	limit,
	page,
	orderBy,
	order,
	startDate,
	endDate,
	transactionId,
	address,
	description,
	format,
	opts = {
		onhold: false,
		additionalHeaders: null
	}
) => {
	let promiseQuery;
	if (kitId) {
		if (type === 'deposit') {
			promiseQuery = getUserByKitId(kitId, false)
				.then((user) => {
					if (!user) {
						throw new Error(USER_NOT_FOUND);
					} else if (!user.network_id) {
						throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
					}
					return getNodeLib().getUserDeposits(user.id, {
						currency,
						status,
						dismissed,
						rejected,
						processing,
						waiting,
						limit,
						page,
						orderBy,
						order,
						startDate,
						endDate,
						transactionId,
						address,
						description,
						format: (format && (format === 'csv' || format === 'all')) ? 'all' : null, // for csv get all data
						...opts
					});
				});
		} else if (type === 'withdrawal') {
			promiseQuery = getUserByKitId(kitId, false)
				.then((user) => {
					if (!user) {
						throw new Error(USER_NOT_FOUND);
					} else if (!user.network_id) {
						throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
					}
					return getNodeLib().getUserWithdrawals(user.id, {
						currency,
						status,
						dismissed,
						rejected,
						processing,
						waiting,
						limit,
						page,
						orderBy,
						order,
						startDate,
						endDate,
						transactionId,
						address,
						description,
						format: (format && (format === 'csv' || format === 'all')) ? 'all' : null, // for csv get all data
						...opts
					});
				});
		}
		return promiseQuery
			.then(async (transactions) => {
				if (transactions.data.length > 0) {
					const networkIds = transactions.data.map((deposit) => deposit.user_id);
					const idDictionary = await mapNetworkIdToKitId(networkIds);
					for (let deposit of transactions.data) {
						const user_kit_id = idDictionary[deposit.user_id];
						deposit.network_id = deposit.user_id;
						deposit.user_id = user_kit_id;
						if (deposit.User) deposit.User.id = user_kit_id;
					}
				}

				if (format && format === 'csv') {
					if (transactions.data.length === 0) {
						throw new Error(NO_DATA_FOR_CSV);
					}

					const csv = parse(transactions.data, Object.keys(transactions.data[0]));
					return csv;
				} else {
					return transactions;
				}
			});
	} else {
		if (type === 'deposit') {
			promiseQuery = getExchangeDeposits(
				currency,
				status,
				dismissed,
				rejected,
				processing,
				waiting,
				limit,
				page,
				orderBy,
				order,
				startDate,
				endDate,
				transactionId,
				address,
				format,
				opts
			);
		} else if (type === 'withdrawal') {
			promiseQuery = getExchangeWithdrawals(
				currency,
				status,
				dismissed,
				rejected,
				processing,
				waiting,
				limit,
				page,
				orderBy,
				order,
				startDate,
				endDate,
				transactionId,
				address,
				format,
				opts
			);
		}
	}
	return promiseQuery
		.then((transactions) => {
			if (format && format === 'csv') {
				if (transactions.data.length === 0) {
					throw new Error(NO_DATA_FOR_CSV);
				}
				const csv = parse(transactions.data, Object.keys(transactions.data[0]));
				return csv;
			} else {
				return transactions;
			}
		});
};

const getUserDepositsByKitId = (
	kitId,
	currency,
	status,
	dismissed,
	rejected,
	processing,
	waiting,
	limit,
	page,
	orderBy,
	order,
	startDate,
	endDate,
	transactionId,
	address,
	description,
	format,
	opts = {
		onhold: false,
		additionalHeaders: null
	}
) => {
	return getUserTransactionsByKitId(
		'deposit',
		kitId,
		currency,
		status,
		dismissed,
		rejected,
		processing,
		waiting,
		limit,
		page,
		orderBy,
		order,
		startDate,
		endDate,
		transactionId,
		address,
		description,
		format,
		opts
	);
};

const getUserWithdrawalsByKitId = (
	kitId,
	currency,
	status,
	dismissed,
	rejected,
	processing,
	waiting,
	limit,
	page,
	orderBy,
	order,
	startDate,
	endDate,
	transactionId,
	address,
	description,
	format,
	opts = {
		onhold: false,
		additionalHeaders: null
	}
) => {
	return getUserTransactionsByKitId(
		'withdrawal',
		kitId,
		currency,
		status,
		dismissed,
		rejected,
		processing,
		waiting,
		limit,
		page,
		orderBy,
		order,
		startDate,
		endDate,
		transactionId,
		address,
		description,
		format,
		opts
	);
};

const getExchangeDeposits = (
	currency,
	status,
	dismissed,
	rejected,
	processing,
	waiting,
	limit,
	page,
	orderBy,
	order,
	startDate,
	endDate,
	transactionId,
	address,
	format,
	opts = {
		onhold: false,
		additionalHeaders: null
	}
) => {

	return getNodeLib().getDeposits({
		currency,
		status,
		dismissed,
		rejected,
		processing,
		waiting,
		limit,
		page,
		orderBy,
		order,
		startDate,
		endDate,
		transactionId,
		address,
		format: (format && (format === 'csv' || format === 'all')) ? 'all' : null, // for csv get all data
		...opts
	})
		.then(async (deposits) => {
			if (deposits.data.length > 0) {
				const networkIds = deposits.data.map((deposit) => deposit.user_id);
				const idDictionary = await mapNetworkIdToKitId(networkIds);
				for (let deposit of deposits.data) {
					const user_kit_id = idDictionary[deposit.user_id];
					deposit.network_id = deposit.user_id;
					deposit.user_id = user_kit_id;
					if (deposit.User) deposit.User.id = user_kit_id;
				}
			}
			return deposits;
		});
};

const getExchangeWithdrawals = (
	currency,
	status,
	dismissed,
	rejected,
	processing,
	waiting,
	limit,
	page,
	orderBy,
	order,
	startDate,
	endDate,
	transactionId,
	address,
	format,
	opts = {
		onhold: false,
		additionalHeaders: null
	}
) => {
	return getNodeLib().getWithdrawals({
		currency,
		status,
		dismissed,
		rejected,
		processing,
		waiting,
		limit,
		page,
		orderBy,
		order,
		startDate,
		endDate,
		transactionId,
		address,
		format: (format && (format === 'csv' || format === 'all')) ? 'all' : null, // for csv get all data
		...opts
	})
		.then(async (withdrawals) => {
			if (withdrawals.data.length > 0) {
				const networkIds = withdrawals.data.map((withdrawal) => withdrawal.user_id);
				const idDictionary = await mapNetworkIdToKitId(networkIds);
				for (let withdrawal of withdrawals.data) {
					const user_kit_id = idDictionary[withdrawal.user_id];
					withdrawal.network_id = withdrawal.user_id;
					withdrawal.user_id = user_kit_id;
					if (withdrawal.User) withdrawal.User.id = user_kit_id;
				}
			}
			return withdrawals;
		});
};

const mintAssetByKitId = async (
	kitId,
	currency,
	amount,
	opts = {
		description: null,
		transactionId: null,
		status: null,
		email: null,
		fee: null,
		address: null,
		dismissed: null,
		rejected: null,
		processing: null,
		waiting: null,
		onhold: null,
		additionalHeaders: null
	}) => {
	// check mapKitIdToNetworkId
	const idDictionary = await mapKitIdToNetworkId([kitId]);

	if (!has(idDictionary, kitId)) {
		throw new Error(USER_NOT_FOUND);
	} else if (!idDictionary[kitId]) {
		throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	}
	return getNodeLib().mintAsset(idDictionary[kitId], currency, amount, opts);
};

const mintAssetByNetworkId = (
	networkId,
	currency,
	amount,
	opts = {
		description: null,
		transactionId: null,
		status: null,
		email: null,
		fee: null,
		address: null,
		dismissed: null,
		rejected: null,
		processing: null,
		waiting: null,
		onhold: null,
		additionalHeaders: null
	}) => {
	return getNodeLib().mintAsset(networkId, currency, amount, opts);
};

const updatePendingMint = (
	transactionId,
	opts = {
		status: null,
		dismissed: null,
		rejected: null,
		processing: null,
		waiting: null,
		onhold: null,
		updatedTransactionId: null,
		email: null,
		updatedDescription: null,
		additionalHeaders: null
	}
) => {
	return getNodeLib().updatePendingMint(transactionId, opts);
};

const burnAssetByKitId = async (
	kitId,
	currency,
	amount,
	opts = {
		description: null,
		transactionId: null,
		status: null,
		email: null,
		fee: null,
		address: null,
		dismissed: null,
		rejected: null,
		processing: null,
		waiting: null,
		onhold: null,
		additionalHeaders: null
	}) => {
	// check mapKitIdToNetworkId
	const idDictionary = await mapKitIdToNetworkId([kitId]);

	if (!has(idDictionary, kitId)) {
		throw new Error(USER_NOT_FOUND);
	} else if (!idDictionary[kitId]) {
		throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	}
	return getNodeLib().burnAsset(idDictionary[kitId], currency, amount, opts);
};

const burnAssetByNetworkId = (
	networkId,
	currency,
	amount,
	opts = {
		description: null,
		transactionId: null,
		status: null,
		email: null,
		fee: null,
		address: null,
		dismissed: null,
		rejected: null,
		processing: null,
		waiting: null,
		onhold: null,
		additionalHeaders: null
	}) => {
	return getNodeLib().burnAsset(networkId, currency, amount, opts);
};

const updatePendingBurn = (
	transactionId,
	opts = {
		status: null,
		dismissed: null,
		rejected: null,
		processing: null,
		waiting: null,
		onhold: null,
		updatedTransactionId: null,
		email: null,
		updatedDescription: null,
		additionalHeaders: null
	}
) => {
	return getNodeLib().updatePendingBurn(transactionId, opts);
};

const getDepositFee = (currency, network, amount, level) => {
	if (!subscribedToCoin(currency)) {
		return reject(new Error(INVALID_COIN(currency)));
	}
	const { deposit_fees } = getKitCoin(currency);

	let fee = 0;
	let fee_coin = currency;
	if (deposit_fees && deposit_fees[currency]) {
		let value = deposit_fees[currency].value;
		fee_coin =  deposit_fees[currency].symbol;
		fee = value;
	}

	const customFee = getKitConfig()?.fiat_fees?.[currency]?.deposit_fee;
	if (customFee) {
		fee_coin = currency;
		fee = customFee;
	}

	return {
		fee,
		fee_coin
	};
};

async function validateDeposit(user, amount, currency, network = null) {
	const coinConfiguration = getKitCoin(currency);

	if (!subscribedToCoin(currency)) {
		throw new Error(INVALID_COIN(currency));
	}

	if (amount <= 0) {
		throw new Error(INVALID_AMOUNT(amount));
	}

	if (!coinConfiguration.allow_deposit) {
		throw new Error(DEPOSIT_DISABLED_FOR_COIN(currency));
	}

	if (!user) {
		throw new Error(USER_NOT_FOUND);
	} else if (!user.network_id) {
		throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	} else if (user.verification_level < 1) {
		throw new Error(UPGRADE_VERIFICATION_LEVEL(1));
	}

	const { fee, fee_coin } = getDepositFee(currency, network, amount, user.verification_level);

	return {
		fee,
		fee_coin
	};
}

const getWallets = async (
	userId,
	currency,
	network,
	address,
	isValid,
	limit,
	page,
	orderBy,
	order,
	format,
	startDate,
	endDate,
	opts = {
		additionalHeaders: null
	}
) => {

	let network_id = null;
	if (userId) {
		// check mapKitIdToNetworkId
		const idDictionary = await mapKitIdToNetworkId([userId]);
		if (!has(idDictionary, userId)) {
			throw new Error(USER_NOT_FOUND);
		} else if (!idDictionary[userId]) {
			throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
		} else {
			network_id = idDictionary[userId];
		}
	}

	return getNodeLib().getExchangeWallets({
		userId: network_id,
		currency,
		network,
		address,
		isValid,
		limit,
		page,
		orderBy,
		order,
		startDate,
		endDate,
		format: (format && (format === 'csv' || format === 'all')) ? 'all' : null, // for csv get all data
		...opts
	})
		.then(async (wallets) => {
			if (wallets.data.length > 0) {
				const networkIds = wallets.data.map((wallet) => wallet.user_id);
				const idDictionary = await mapNetworkIdToKitId(networkIds);
				for (let wallet of wallets.data) {
					const user_kit_id = idDictionary[wallet.user_id];
					wallet.network_id = wallet.user_id;
					wallet.user_id = user_kit_id;
					if (wallet.User) wallet.User.id = user_kit_id;
				}
			}
			if(format === 'csv'){
				const csv = parse(wallets.data, Object.keys(wallets.data[0]));
				return csv;
			}
			return wallets;
		});
};

const getUserWithdrawalCode = async () => {
	const data = await client.hgetallAsync(WITHDRAWALS_REQUEST_KEY);
	if (!data) return null;

	let latestToken = null;
	let latestTimestamp = 0;

	for (const [token, rawString] of Object.entries(data)) {
		try {
			const parsed = JSON.parse(rawString);
			if (parsed.timestamp > latestTimestamp) {
				latestTimestamp = parsed.timestamp;
				latestToken = token;
			}
		} catch (e) {
			return e;
		}
	}
	return latestToken;
};

const createUserWalletByNetworkId = (networkId, currency, address, opts = {
	network: null,
	skipValidate: false,
	additionalHeaders: null
}) => {
	if (!networkId) {
		return reject(new Error(USER_NOT_REGISTERED_ON_NETWORK));
	}
	return getNodeLib().createUserWallet(networkId, currency, address, opts);
};

const createUserWalletByKitId = async (kitId, currency, address, opts = {
	network: null,
	skipValidate: false,
	additionalHeaders: null
}) => {
	// check mapKitIdToNetworkId
	const idDictionary = await mapKitIdToNetworkId([kitId]);

	if (!has(idDictionary, kitId)) {
		throw new Error(USER_NOT_FOUND);
	} else if (!idDictionary[kitId]) {
		throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	}

	return getNodeLib().createUserWallet(idDictionary[kitId], currency, address, opts);
};

module.exports = {
	sendRequestWithdrawalEmail,
	validateWithdrawal,
	validateWithdrawalToken,
	cancelUserWithdrawalByKitId,
	checkTransaction,
	performWithdrawal,
	performDirectWithdrawal,
	transferAssetByKitIds,
	getUserBalanceByKitId,
	getUserDepositsByKitId,
	getUserWithdrawalsByKitId,
	performWithdrawalNetwork,
	cancelUserWithdrawalByNetworkId,
	getExchangeDeposits,
	getExchangeWithdrawals,
	getUserBalanceByNetworkId,
	transferAssetByNetworkIds,
	mintAssetByKitId,
	mintAssetByNetworkId,
	burnAssetByKitId,
	burnAssetByNetworkId,
	getKitBalance,
	updatePendingMint,
	updatePendingBurn,
	isValidAddress,
	validateDeposit,
	getWallets,
	calculateWithdrawalMax,
	getUserWithdrawalCode,
	createUserWalletByNetworkId,
	createUserWalletByKitId
};
