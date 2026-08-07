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

const performWithdrawal = async (userId, address, currency, amount, opts = {
	network: null,
	fee_markup: null,
	additionalHeaders: null
}) => {
	// LBTC: local hot wallet withdrawal (before subscribedToCoin check)
	if (currency === 'lbtc') {
		const { Client } = require('pg');
		const http = require('http');
		const crypto = require('crypto');
		const bitcoin = require('bitcoinjs-lib');
		const ecc = require('tiny-secp256k1');
		const { ECPairFactory } = require('ecpair');
		const bip32 = require('bip32');
		const bip39 = require('bip39');
		const fs = require('fs');

		bitcoin.initEccLib(ecc);
		const ECPair = ECPairFactory(ecc);

		const LBTC_RPC_HOST = process.env.LBTC_RPC_HOST || 'host.docker.internal';
		const LBTC_RPC_PORT = parseInt(process.env.LBTC_RPC_PORT) || 19557;

		const LBTC_NETWORK = {
			messagePrefix: '\x1cLigercoin Signed Message:\n',
			bip32: { public: 0x0488B21E, private: 0x0488ADE4 },
			pubKeyHash: 0x30,
			scriptHash: 0x32,
			wif: 0xB0,
		};

		// Load hot wallet
		const walletPath = '/opt/forkex/wallets/lbtc-hot-wallet.json';
		const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
		const seed = bip39.mnemonicToSeedSync(wallet.mnemonic);
		const root = bip32.default(ecc).fromSeed(seed);
		const child = root.derivePath(wallet.path);
		const hotKeyPair = ECPair.fromPrivateKey(child.privateKey);
		const hotAddr = bitcoin.payments.p2pkh({ pubkey: hotKeyPair.publicKey, network: LBTC_NETWORK }).address;

		// RPC helper
		function rpcCall(method, params = []) {
			return new Promise((resolve, reject) => {
				const body = JSON.stringify({ jsonrpc: '1.0', method, params, id: Date.now() });
				const opts = {
					hostname: LBTC_RPC_HOST, port: LBTC_RPC_PORT, method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': 'Basic ' + Buffer.from('coin:coin').toString('base64'),
						'Content-Length': Buffer.byteLength(body),
					},
				};
				const req = http.request(opts, (res) => {
					let data = '';
					res.on('data', (chunk) => data += chunk);
					res.on('end', () => {
						try { const json = JSON.parse(data); json.error ? reject(new Error(json.error.message)) : resolve(json.result); }
						catch (e) { reject(e); }
					});
				});
				req.on('error', reject);
				req.write(body);
				req.end();
			});
		}

		function bs58decode(str) {
			const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
			let result = BigInt(0);
			for (const c of str) { const idx = alphabet.indexOf(c); if (idx < 0) throw new Error('Invalid base58'); result = result * BigInt(58) + BigInt(idx); }
			const hex = result.toString(16).padStart(2, '0');
			const bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
			const leadingOnes = str.split('').filter(c => c === '1').length;
			return Buffer.concat([Buffer.alloc(leadingOnes), bytes]);
		}

		function addressToOutputScript(address) {
			const decoded = bs58decode(address);
			const hash = decoded.slice(1, 21);
			return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.from(hash), Buffer.from([0x88, 0xac])]);
		}

		function pushData(data) {
			const len = data.length;
			if (len < 0x4c) return Buffer.from([len]);
			if (len < 0x100) return Buffer.from([0x4c, len]);
			return Buffer.from([0x4d, len & 0xff, (len >> 8) & 0xff]);
		}

		function encodeDER(sig) {
			const r = sig.subarray(0, 32), s = sig.subarray(32, 64);
			let rStart = 0; while (rStart < r.length - 1 && r[rStart] === 0) rStart++;
			let sStart = 0; while (sStart < s.length - 1 && s[sStart] === 0) sStart++;
			const rBytes = r.subarray(rStart), sBytes = s.subarray(sStart);
			const rBuf = (rBytes[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), rBytes]) : rBytes;
			const sBuf = (sBytes[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), sBytes]) : sBytes;
			return Buffer.concat([Buffer.from([0x30, 2 + rBuf.length + 2 + sBuf.length]), Buffer.from([0x02, rBuf.length]), rBuf, Buffer.from([0x02, sBuf.length]), sBuf]);
		}

		function parseBlockTxids(hexStr) {
			const data = Buffer.from(hexStr, 'hex');
			if (data.length < 80) return [];
			const body = data.subarray(80);
			let offset = 0;
			const readVarInt = (buf, off) => { const b = buf[off]; if (b < 0xfd) return { value: b, bytesRead: 1 }; if (b === 0xfd) return { value: buf.readUInt16LE(off + 1), bytesRead: 3 }; if (b === 0xfe) return { value: buf.readUInt32LE(off + 1), bytesRead: 5 }; return { value: Number(buf.readBigUInt64LE(off + 1)), bytesRead: 9 }; };
			const skipTx = (buf, off) => { off += 4; let segwit = false; if (buf[off] === 0x00) { segwit = true; off += 2; } let { value: inC, bytesRead: bl } = readVarInt(buf, off); off += bl; for (let i = 0; i < inC; i++) { off += 36; const { value: sl, bytesRead: slb } = readVarInt(buf, off); off += slb + sl; off += 4; } let { value: outC, bytesRead: ol } = readVarInt(buf, off); off += ol; for (let i = 0; i < outC; i++) { off += 8; const { value: sl, bytesRead: slb } = readVarInt(buf, off); off += slb + sl; } if (segwit) { for (let i = 0; i < inC; i++) { let { value: sc, bytesRead: scl } = readVarInt(buf, off); off += scl; for (let j = 0; j < sc; j++) { const { value: il, bytesRead: ilb } = readVarInt(buf, off); off += ilb + il; } } } off += 4; return off; };
			const { value: count, bytesRead: countLen } = readVarInt(body, offset); offset += countLen;
			const txids = [];
			for (let i = 0; i < count; i++) {
				const txStart = offset; offset = skipTx(body, offset);
				const txBytes = body.subarray(txStart, offset);
				const h1 = crypto.createHash('sha256').update(txBytes).digest();
				const h2 = crypto.createHash('sha256').update(h1).digest(); h2.reverse();
				txids.push(h2.toString('hex'));
			}
			return txids;
		}

		// Get tip
		const tip = await rpcCall('getblockcount');
		const fromHeight = Math.max(0, tip - 500);

		// Scan UTXOs for hot wallet
		const scriptPubKeyHex = addressToOutputScript(hotAddr).toString('hex');
		const utxos = [];
		const spentOutpoints = new Set();
		for (let h = fromHeight; h <= tip; h++) {
			const hash = await rpcCall('getblockhash', [h]);
			const block = await rpcCall('getblock', [hash]);
			const txids = Array.isArray(block.tx) ? block.tx : [];
			if (txids.length === 0 && block.hex) { try { txids.push(...parseBlockTxids(block.hex)); } catch (e) {} }
			for (const txid of txids) {
				try {
					const tx = await rpcCall('getrawtransaction', [txid, true]);
					for (const vin of (tx.vin || [])) { if (vin.txid) spentOutpoints.add(`${vin.txid}:${vin.vout}`); }
					for (let n = 0; n < (tx.vout || []).length; n++) {
						const vout = tx.vout[n];
						if (vout.scriptPubKey?.hex === scriptPubKeyHex) {
							const outpoint = `${txid}:${n}`;
							if (!spentOutpoints.has(outpoint)) {
								utxos.push({ txid, vout: n, value: vout.value, scriptPubKey: vout.scriptPubKey.hex, confirmations: (tx.confirmations || 0) });
							}
						}
					}
				} catch (e) {}
			}
		}

		// Remove UTXOs that were already spent by later txs in the same scan range
		const unspentUtxos = utxos.filter(u => !spentOutpoints.has(`${u.txid}:${u.vout}`));

		const fee = 0.0001;
		const totalAvailable = unspentUtxos.reduce((s, u) => s + u.value, 0);
		if (totalAvailable < amount + fee) throw new Error(`Insufficient hot wallet funds: ${totalAvailable} LBTC available, need ${amount + fee}`);

		// Select UTXOs
		unspentUtxos.sort((a, b) => b.value - a.value);
		let selected = [], selectedTotal = 0;
		for (const utxo of unspentUtxos) { selected.push(utxo); selectedTotal += utxo.value; if (selectedTotal >= amount + fee) break; }

		// Build and sign tx
		const tx = new bitcoin.Transaction(); tx.version = 2;
		const inputScripts = [];
		for (const utxo of selected) { tx.addInput(Buffer.from(utxo.txid, 'hex').reverse(), utxo.vout); inputScripts.push(Buffer.from(utxo.scriptPubKey, 'hex')); }
		const recipientScript = addressToOutputScript(address);
		tx.addOutput(recipientScript, BigInt(Math.round(amount * 1e8)));
		const changeRaw = selectedTotal - amount - fee;
		if (changeRaw > 0.000005) tx.addOutput(addressToOutputScript(hotAddr), BigInt(Math.round(changeRaw * 1e8)));

		for (let i = 0; i < selected.length; i++) {
			const sigHash = tx.hashForSignature(i, inputScripts[i], bitcoin.Transaction.SIGHASH_ALL);
			const sig = hotKeyPair.sign(Buffer.from(sigHash));
			const derSig = encodeDER(sig);
			const combined = Buffer.concat([derSig, Buffer.from([0x01])]);
			const inputScript = Buffer.concat([pushData(combined), combined, pushData(hotKeyPair.publicKey), Buffer.from(hotKeyPair.publicKey)]);
			tx.setInputScript(i, inputScript);
		}

		// Broadcast
		const txid = await rpcCall('sendrawtransaction', [tx.toHex()]);

		// Record in DB
		const dbHost = process.env.DB_HOST || '127.0.0.1';
		const dbPort = parseInt(process.env.DB_PORT) || 5432;
		const db = new Client({ host: dbHost, port: dbPort, database: process.env.DB_NAME || 'hollaex', user: process.env.DB_USER || 'admin', password: process.env.DB_PASS || 'root' });
		await db.connect();
		try {
			// Deduct from requesting user
			await db.query(
				`UPDATE balances SET balance = balance - $1::numeric, available = available - $1::numeric, updated_at = NOW()
				 WHERE user_id = $2::int AND currency = 'lbtc' AND (balance - $1::numeric) >= 0`,
				[amount + fee, userId]
			);
			// Also deduct from hot wallet (user 1) — hot wallet is the actual on-chain sender
			const HOT_WALLET_USER_ID = 1;
			if (userId !== HOT_WALLET_USER_ID) {
				await db.query(
					`UPDATE balances SET balance = balance - $1::numeric, available = available - $1::numeric, updated_at = NOW()
					 WHERE user_id = $2::int AND currency = 'lbtc' AND (balance - $1::numeric) >= 0`,
					[amount + fee, HOT_WALLET_USER_ID]
				);
				await db.query(
					`UPDATE user_wallets SET balance = b.balance, available = b.available, updated_at = NOW()
					 FROM balances b WHERE user_wallets.user_id = b.user_id AND user_wallets.currency = b.currency
					 AND user_wallets.user_id = $1::int AND user_wallets.currency = 'lbtc'`,
					[HOT_WALLET_USER_ID]
				);
			}
			await db.query(
				`INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, tx_hash, address, network, metadata, created_at, updated_at)
				 VALUES ($1::int, 'withdrawal', $2::numeric, 'lbtc', 'completed', $3::numeric, 'lbtc', 'On-chain LBTC withdrawal', $4, $5, 'lbtc', '{}', NOW(), NOW())`,
				[userId, amount, fee, txid, address]
			);
			await db.query(
				`UPDATE user_wallets SET balance = b.balance, available = b.available, updated_at = NOW()
				 FROM balances b WHERE user_wallets.user_id = b.user_id AND user_wallets.currency = b.currency
				 AND user_wallets.user_id = $1::int AND user_wallets.currency = 'lbtc'`,
				[userId]
			);
		} finally { await db.end(); }

		return { transaction_id: txid, fee };
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
	const balance = await getNodeLib().getUserBalance(user.network_id);
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

	// For LBTC: use kit user_id directly (no network node)
	const balanceUserId = currency === 'lbtc' ? user.id : user.network_id;
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
	// check mapKitIdToNetworkId
	const idDictionary = await mapKitIdToNetworkId([userKitId]);

	if (!has(idDictionary, userKitId)) {
		throw new Error(USER_NOT_FOUND);
	} else if (!idDictionary[userKitId]) {
		throw new Error(USER_NOT_REGISTERED_ON_NETWORK);
	}

	return getNodeLib().getUserBalance(idDictionary[userKitId], opts)
		.then((data) => {
			return {
				user_id: userKitId,
				...data
			};
		});
};

const getUserBalanceByNetworkId = (networkId, opts = {
	additionalHeaders: null
}) => {
	if (!networkId) {
		return reject(new Error(USER_NOT_REGISTERED_ON_NETWORK));
	}
	return getNodeLib().getUserBalance(networkId, opts);
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
