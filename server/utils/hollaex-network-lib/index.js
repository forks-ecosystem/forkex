'use strict';

const moment = require('moment');
const {
	isBoolean,
	isPlainObject,
	isNumber,
	isString,
	isArray,
	isBuffer,
	omit,
	isNull,
	isEmpty,
	snakeCase
} = require('lodash');
const {
	createRequest,
	generateHeaders,
	checkKit,
	createSignature,
	parameterError,
	isDatetime,
	sanitizeDate,
	isUrl
} = require('./utils');
const WebSocket = require('ws');
const { setWsHeartbeat } = require('ws-heartbeat/client');
const { getApiKeyForUser } = require('../../helpers/user');
const { reject } = require('bluebird');
const FileType = require('file-type');
const { client } = require('../hollaex-tools-lib/tools/database/redis');
const { getOrdersUtils } = require('../getOrdersUtils');
const { getDepositsUtils } = require('../deposits');
const { getAdminDepositsUtils } = require('../depositsUtils');

const { getUserBalanceUtils } = require('../getUserBalanceUtils');
const { getBalancesUtils } = require('../balances');
const { createBrokerTradeUtils } = require('../brokerTrade');
const { cancelOrderUtils } = require('../cancelOrder');
const { getUserOrdersUtils } = require('../userOrders');
const { getUserStatsUtils } = require('../userStats');
const { checkTransactionUtils } = require('../checkTransaction');
const { transferAssetUtils } = require('../transferAsset');
const { getTradesHistoryUtils } = require('../tradesHistory');
const { getOrderbooksUtils } = require('../orderbooks');
const { getOraclePricesUtils } = require('../getOraclePrices');
const { getPublicTradesUtils } = require('../publicTrades');
const { generateDashTokenUtils } = require('../generateDashTokenUtils');

const { generateWallet } = require('../../wallets/generate'); // корректный путь
const { getExchangeWalletsUtils } = require('../getExchangeWalletsUtils');
const { getTradesUtils } = require('../trades');
const { getUserTradesUtils } = require('../usertrades');
const { getOrderbookUtils } = require('../getOrderbook');
const { getWithdrawalsUtils } = require('../withdrawals');
const { Pair } = require('../../db/models');
const { sequelize: db } = require('../../db/models');
const { loggerWebsocket } = require('../../config/logger');


//const { Trade } = require('../db/models');
//const { Op } = require('sequelize');
const { getPrice } = require('../price');

// В начале вашего файла или в основном скрипте
/*
window.USE_LOCAL_UDF = true;
window.UDF_CONFIG = {
    exchangeName: 'FORKEX',
    resolutions: ["1", "5", "15", "30", "60", "240", "D", "W"],
    availablePairs: ['BTC/USDT', 'ETH/USDT', 'BNB/USDT']
};
*/
class HollaExNetwork {
	constructor(
		opts = {
			apiUrl: 'https://forkex.life',
			baseUrl: '/v2',
			apiKey: '40bf98ad7d09cd3252ce9618be0cd74955f4c804',
			apiSecret: '14e98aa9b741767ccb8ce9693837d96c83451fb39c81f399f1',
			apiExpiresAfter: 60,
			activation_code: '7cfa7eab-9b21-4037-ae28-lbfa39ca98a3',
			kit_version: '2.17.0'
		}
	) {
		this.apiUrl = opts.apiUrl || 'https://forkex.life';
		this.baseUrl = opts.baseUrl || '/v2';
		this.apiKey = opts.apiKey;
		this.apiSecret = opts.apiSecret;
		this.apiExpiresAfter = opts.apiExpiresAfter || 60;
		this.headers = {
			'content-type': 'application/json',
			Accept: 'application/json',
			'api-key': opts.apiKey
		};

		if (opts.kit_version) {
			this.headers['kit-version'] = opts.kit_version;
		}

		this.activation_code = opts.activation_code;
		this.exchange_id = opts.exchange_id;
		this.wsUrl = 'wss://forkex.life/stream';
		this.ws = 'ws://forkex.life/stream';
		this.wsEvents = [];
		this.wsReconnect = true;
		this.wsReconnectInterval = 5000;
		this.wsEventListeners = null;
		this.wsConnected = () => this.ws && this.ws.readyState === WebSocket.OPEN;

	}

	/* Kit Operator Network Endpoints*/

	/**
	 * Initialize your Kit for HollaEx Network. Must have passed activation_code in constructor
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Your exchange values
	 */
	async init(opts = {
		additionalHeaders: null
	}) {
    loggerWebsocket.info('>=======  activation_code:', this.activation_code);
		checkKit(this.activation_code);
		const verb = 'GET';
		const path = `${this.baseUrl}/network/init/${this.activation_code}`;
		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter
		);
		let exchange = await createRequest(
			verb,
			`${this.apiUrl}${path}`,
			headers
		);
		this.exchange_id = exchange.id;
		return exchange;
	}

	/**
	 * Create a user for the exchange on the network
	 * @param {string} email - Email of new user
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Created user's values on network
	 */
	createUser(email, password, opts = { additionalHeaders: null }) {
                if (!email || !password) {
                    return reject(parameterError('email/password', 'cannot be null'));
                }
		const verb = 'POST';
                const path = `/signup`;
                const data = { email, password };
                //const data = { signup: { email, password } };
		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

async getTrades(
    userId,
    opts = {
        symbol: null,
        limit: null,
        page: null,
        orderBy: null,
        order: null,
        startDate: null,
        endDate: null,
        format: 'json',
        additionalHeaders: null
    }
) {
    if (!userId) {
        return reject(parameterError('userId', 'cannot be null'));
    }
    console.log('=== getTrades user_id: ', userId);
    const queryParams = { user_id: userId };
    if (isString(opts.symbol)) queryParams.symbol = opts.symbol;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };
        return await getTradesUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

async getUserTrades(
    userId,
    opts = {
        symbol: null,
        limit: 50,
        page: 1,
        orderBy: null,
        order: 'asc',
        startDate: null,
        endDate: null,
        format: 'json',
        additionalHeaders: null
    }
) {
    if (!userId) { return reject(parameterError('userId', 'cannot be null')); }
    // Создаем объект для параметров запроса
    const queryParams = { user_id: userId };
    console.log('=== getUserTrades user_id: ', userId);
    // Добавляем параметры, если они переданы
    if (isString(opts.symbol)) queryParams.symbol = opts.symbol;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        // Создаем объект mockReq с параметрами запроса
        const mockReq = { query: queryParams };
        // Создаем mockRes для обработки ответа
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };
        // Передаем параметры в утилиту
        return await getUserTradesUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

async getUser(req, res) {
    try {
        const auth = req.auth || req.user;
        if (!auth || !auth.sub || !auth.sub.id) {
            return { error: true, message: 'Invalid or expired token' };
        }
        const userId = auth.sub.id;
        const user = await User.findByPk(userId, {
            attributes: { exclude: ['password', 'otp'] }
        });
        if (!user) {
            return { error: true, message: 'User not found' };
        }
        return res.json(user);
    } catch (err) {
        loggerWebsocket.error('getUser error ', err);
        return res.status(500).json({ message: 'Internal error' });
    }
}

async createUserCryptoAddress(userId, crypto, opts = {
    network: null,
    additionalHeaders: null
}) {
    if (!userId) {
        throw parameterError('userId', 'cannot be null');
    }
    if (!crypto) {
        throw parameterError('crypto', 'cannot be null');
    }
    try {
        const result = await generateWallet(userId, crypto, opts.network);
        return result;
    } catch (error) {
        console.error('Error creating crypto address:', error);
        throw error;
    }
}

async getExchangeWallets(
    opts = {
        userId: null,
        currency: null,
        network: null,
        address: null,
        isValid: null,
        limit: 50,
        page: 1,
        orderBy: null,
        order: 'asc',
        startDate: null,
        endDate: null,
        format: 'json',
        additionalHeaders: null
    }
) {
    console.log('=== getExchangeWakkets user_id: ', this.exchange_id);
    const queryParams = {};
    if (opts.userId) queryParams.user_id = opts.userId;
    if (isString(opts.currency)) queryParams.currency = opts.currency;
    if (isString(opts.network)) queryParams.network = opts.network;
    if (isString(opts.address)) queryParams.address = opts.address;
    if (isBoolean(opts.isValid)) queryParams.is_valid = opts.isValid;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };
        return await getExchangeWalletsUtils(mockReq, mockRes);
    } catch (error) {
        return Promise.reject(error);
    }
}

	/**
	 * Create a withdrawal for an exchange's user on the network
	 * @param {number} userId - User id on network
	 * @param {string} address - Address to send withdrawal to
	 * @param {string} currency - Curreny to withdraw
	 * @param {number} amount - Amount to withdraw
	 * @param {object} opts - Optional parameters.
	 * @param {string} opts.network - Specify crypto currency network
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Withdrawal made on the network
	 */
	performWithdrawal(userId, address, currency, amount, opts = {
		network: null,
		fee_markup: null,
		additionalHeaders: null
	}) {
		if (!userId) {
			return reject(parameterError('userId', 'cannot be null'));
		} else if (!address) {
			return reject(parameterError('address', 'cannot be null'));
		} else if (!currency) {
			return reject(parameterError('currency', 'cannot be null'));
		} else if (!amount || amount <= 0) {
			return reject(parameterError('amount', 'cannot be null'));
		}

		const verb = 'POST';
                const path = `/withdraw?user_id=${userId}`;
		const data = { address, currency, amount };
		if (opts.network) {
			data.network = opts.network;
		}
		if (opts.fee_markup) {
			data.fee_markup = opts.fee_markup;
		}
		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Cancel a withdrawal for an exchange's user on the network
	 * @param {number} userId - User id on network
	 * @param {string} withdrawalId - Withdrawal's id on network (not transaction id).
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Withdrawal canceled on the network
	 */
	cancelWithdrawal(userId, withdrawalId, opts = {
		additionalHeaders: null
	}) {
		if (!userId) {
			return reject(parameterError('userId', 'cannot be null'));
		} else if (!withdrawalId) {
			return reject(parameterError('withdrawalId', 'cannot be null'));
		}

		const verb = 'DELETE';
                const path = `/withdraw?user_id=${userId}&id=${withdrawalId}`;
		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers);
	}

	/**
	 */
async getDeposits(
    opts = {
        currency: null,
        status: null,
        dismissed: null,
        rejected: null,
        processing: null,
        waiting: null,
        limit: 50,
        page: 1,
        orderBy: null,
        order: 'asc',
        startDate: null,
        endDate: null,
        transactionId: null,
        address: null,
        format: 'json',
        additionalHeaders: null
    }
) {
    const queryParams = {};  
    if (isString(opts.currency)) queryParams.currency = opts.currency;
    if (isBoolean(opts.status)) queryParams.status = opts.status;
    if (isBoolean(opts.dismissed)) queryParams.dismissed = opts.dismissed;
    if (isBoolean(opts.rejected)) queryParams.rejected = opts.rejected;
    if (isBoolean(opts.processing)) queryParams.processing = opts.processing;
    if (isBoolean(opts.waiting)) queryParams.waiting = opts.waiting;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isString(opts.address)) queryParams.address = opts.address;
    if (isString(opts.transactionId)) queryParams.transaction_id = opts.transactionId;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };
        // Передаем параметры в утилиту (замени на фактическую утилиту, если имя другое)
        return await getAdminDepositsUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}
	/**
	 */
async getUserDeposits(
    userId,
    opts = {
        currency: null,
        status: null,
        dismissed: null,
        rejected: null,
        processing: null,
        waiting: null,
        limit: null,
        page: null,
        orderBy: null,
        order: null,
        startDate: null,
        endDate: null,
        transactionId: null,
        address: null,
        format: null,
        additionalHeaders: null
    }
) {
    if (!userId) { return reject(parameterError('userId', 'cannot be null')); }
    const queryParams = { user_id: userId };
    if (isNumber(opts.limit))         queryParams.limit = opts.limit;
    if (isNumber(opts.page))          queryParams.page = opts.page;
    if (isString(opts.orderBy))       queryParams.order_by = opts.orderBy;
    if (isString(opts.order))         queryParams.order = opts.order;
    if (isString(opts.address))       queryParams.address = opts.address;
    if (isString(opts.transactionId)) queryParams.transaction_id = opts.transactionId;
    if (isDatetime(opts.startDate))   queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate))     queryParams.end_date = sanitizeDate(opts.endDate);
    if (opts.currency)                queryParams.currency = opts.currency;
    if (isBoolean(opts.status))       queryParams.status = opts.status;
    if (isBoolean(opts.dismissed))    queryParams.dismissed = opts.dismissed;
    if (isBoolean(opts.rejected))     queryParams.rejected = opts.rejected;
    if (isBoolean(opts.processing))   queryParams.processing = opts.processing;
    if (isBoolean(opts.waiting))      queryParams.waiting = opts.waiting;
    if (isString(opts.format))        queryParams.format = opts.format;
    try {
        // Mock a request object that the utility function expects
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };
        return await getDepositsUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}
	/**
	 * Get all withdrawals for the exchange on the network
	 * @param {object} opts - Optional parameters.
	 * @param {string} opts.currency - Currency of withdrawals. Leave blank to get withdrawals for all currencies
	 * @param {boolean} opts.status - Confirmed status of the withdrawals to get. Leave blank to get all confirmed and unconfirmed withdrawals
	 * @param {boolean} opts.dismissed - Dismissed status of the withdrawals to get. Leave blank to get all dismissed and undismissed withdrawals
	 * @param {boolean} opts.rejected - Rejected status of the withdrawals to get. Leave blank to get all rejected and unrejected withdrawals
	 * @param {boolean} opts.processing - Processing status of the withdrawals to get. Leave blank to get all processing and unprocessing withdrawals
	 * @param {boolean} opts.waiting - Waiting status of the withdrawals to get. Leave blank to get all waiting and unwaiting withdrawals
	 * @param {number} opts.limit - Amount of trades per page. Maximum: 50. Default: 50
	 * @param {number} opts.page - Page of trades data. Default: 1
	 * @param {string} opts.orderBy - The field to order data by e.g. amount, id.
	 * @param {string} opts.order - Ascending (asc) or descending (desc).
	 * @param {string} opts.startDate - Start date of query in ISO8601 format.
	 * @param {string} opts.endDate - End date of query in ISO8601 format.
	 * @param {string} opts.transactionId - Withdrawals with specific transaction ID.
	 * @param {string} opts.address - Withdrawals with specific address.
	 * @param {string} opts.format - Custom format of data set. Enum: ['all']
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Fields: Count, Data. Count is the number of withdrawals on the page. Data is an array of withdrawals
	 */
async getUserWithdrawals(
    userId,
    opts = {
        currency: null,
        status: null,
        dismissed: null,
        rejected: null,
        processing: null,
        waiting: null,
        limit: 50,
        page: 1,
        orderBy: null,
        order: 'asc',
        startDate: null,
        endDate: null,
        transactionId: null,
        address: null,
        format: 'json',
        additionalHeaders: null
    }
) {
    if (!userId) {
        return reject(parameterError('userId', 'cannot be null'));
    }
    // Создаем объект параметров запроса
    const queryParams = { user_id: userId };
    console.log('=== getUserWithdrawals user_id: ', userId);
    if (isString(opts.currency)) queryParams.currency = opts.currency;
    if (isBoolean(opts.status)) queryParams.status = opts.status;
    if (isBoolean(opts.dismissed)) queryParams.dismissed = opts.dismissed;
    if (isBoolean(opts.rejected)) queryParams.rejected = opts.rejected;
    if (isBoolean(opts.processing)) queryParams.processing = opts.processing;
    if (isBoolean(opts.waiting)) queryParams.waiting = opts.waiting;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isString(opts.address)) queryParams.address = opts.address;
    if (isString(opts.transactionId)) queryParams.transaction_id = opts.transactionId;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };
        return await getWithdrawalsUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

	/**
	 */
	async getUserBalance(userId, opts = { format: 'json' }) {
	    if (!userId) return reject(parameterError('userId'));
	    // For self-hosted: use local DB, userId is kit user_id
	    const user_id = userId;
	    console.log('=1= getUserBalance user_id: ', user_id);
	    const mockReq = { query: { user_id } };
	    const mockRes = {
	        status: () => ({ json: d => d }),
	        json: d => d
	    };
	    return getUserBalanceUtils(mockReq, mockRes);
	}
	/**
	 */
 getBalance(opts = {
    additionalHeaders: null
}) {
    const { Balance, Coin } = require('../../db/models');
    return Promise.all([
        Balance.findAll(),
        Coin.findAll({ where: { is_public: true, active: true }, attributes: ['symbol'] })
    ]).then(([balances, publicCoins]) => {
        const publicSymbols = new Set(publicCoins.map(c => c.symbol));
        const result = {};
        balances.forEach(b => {
            if (!publicSymbols.has(b.currency)) return;
            if (!result[b.currency]) {
                result[b.currency] = { balance: 0, available: 0, pending: 0 };
            }
            result[b.currency].balance += Number(b.balance);
            result[b.currency].available += Number(b.available);
            result[b.currency].pending += Number(b.balance) - Number(b.available);
        });
        return result;
    });
}

	/**
	 */
 async getBalances(opts = {
    userId: null,
    currency: null,
    format: null,
    additionalHeaders: null
}) {
    const queryParams = {};
    if (opts.userId) queryParams.user_id = opts.userId;
    if (opts.currency) queryParams.currency = opts.currency;
    if (isString(opts.format)) queryParams.format = opts.format;
    console.log('=== getBalances user_id: ', opts.userId);
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };
        return await getBalancesUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}
	/**
	 */
async createBrokerTrade(
    symbol,
    side,
    price,
    size,
    makerId,
    takerId,
    feeStructure,
    opts = { additionalHeaders: null }
) {
    console.log('=== getBrokerTrade : ok');
    // ✅ Валидация (оставляем как есть)
    if (!symbol) return reject(parameterError('symbol'));
    if (!side) return reject(parameterError('side'));
    if (!['buy', 'sell'].includes(side)) {
        return reject(parameterError('side', 'must be buy or sell'));
    }
    if (!size) return reject(parameterError('size'));
    if (!makerId) return reject(parameterError('makerId'));
    if (!takerId) return reject(parameterError('takerId'));
    if (!feeStructure) return reject(parameterError('feeStructure'));
    if (isNull(feeStructure.maker)) {
        return reject(parameterError('feeStructure.maker'));
    }
    if (isNull(feeStructure.taker)) {
        return reject(parameterError('feeStructure.taker'));
    }
    try {
        const mockReq = {
            body: {
                symbol,
                side,
                price,
                size,
                maker_id: makerId,
                taker_id: takerId,
                fee_structure: feeStructure
            }
        };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200 || code === 201) return data;
                    throw new Error(data.error || 'Trade failed');
                }
            }),
            json: (data) => data
        };
        return await createBrokerTradeUtils(mockReq, mockRes);
    } catch (err) {
        return reject(err);
    }
}
	/**
	 */
async getOrder(
    userId,
    orderId,
    opts = { additionalHeaders: null }
) {
    if (!userId) {
        return reject(parameterError('userId', 'cannot be null'));
    }
    if (!orderId) {
        return reject(parameterError('orderId', 'cannot be null'));
    }
    console.log('=== getOrder user_id: ', userId);
    try {
        const mockReq = {
            query: {
                user_id: userId,
                order_id: orderId
            }
        };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to fetch order');
                }
            }),
            json: (data) => data
        };
        return await getOrderUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

	/**
	 */
async createOrder(
    userId,
    symbol,
    side,
    size,
    type,
    price = 0,
    feeData = {
        fee_structure: null,
        fee_coin: null
    },
    opts = {
        stop: null,
        meta: null,
        additionalHeaders: null
    }
) {
    loggerWebsocket.error('=== createOrder user_id: ', userId);
    if (!userId) {
        return Promise.reject(parameterError('userId', 'cannot be null'));
    } else if (!symbol) {
        return Promise.reject(parameterError('symbol', 'cannot be null'));
    } else if (side !== 'buy' && side !== 'sell') {
        return Promise.reject(parameterError('side', 'must be buy or sell'));
    } else if (!size) {
        return Promise.reject(parameterError('size', 'cannot be null'));
    } else if (type !== 'market' && type !== 'limit') {
        return Promise.reject(parameterError('type', 'must be limit or market'));
    } else if (!price && type !== 'market') {
        return Promise.reject(parameterError('price', 'cannot be null for limit orders'));
    } else if (!isPlainObject(feeData) || !isPlainObject(feeData.fee_structure)) {
        return Promise.reject(parameterError('feeData', 'feeData must be an object and contain fee_structure'));
    }
    const data = { symbol, side, size, type, price };
    if (isPlainObject(feeData.fee_structure)) { data.fee_structure = feeData.fee_structure; }
    if (feeData.fee_coin) { data.fee_coin = feeData.fee_coin; }
    if (isPlainObject(opts.meta)) { data.meta = opts.meta; }
    if (opts.stop) { data.stop = opts.stop; }
    // Получить pair_id по symbol
    const res = await db.query(
        'SELECT id FROM pairs WHERE symbol = $1',
        { bind: [symbol], type: db.QueryTypes.SELECT }
    );
    if (res.length === 0) {
        throw new Error(`Unknown symbol: ${symbol}`);
    }
    const pairId = res[0].id;
    // Вставить ордер
    const insertQuery = `
INSERT INTO orders (
  user_id,
  pair_id,
  side,
  price,
  size,
  status,
  fee,
  accepted,
  accepted_amount,
  symbol,
  created_at,
  updated_at
) VALUES (
  $1, $2, $3, $4, $5,
  'open',
  0,
  false,
  0,
  $6,
  NOW(),
  NOW()
)
RETURNING order_id;
    `;


    const insertValues = [userId, pairId, side, price, size, symbol];
    const result = await db.query(
        insertQuery,
        { bind: insertValues, type: db.QueryTypes.INSERT }
    );
    return {
        order_id: result[0][0].order_id,
        status: 'open',
        message: 'Order created'
    };
}

	/**
	 */
async cancelOrder(
    userId,
    orderId,
    opts = { additionalHeaders: null }
) {
    if (!userId) {
        return reject(parameterError('userId', 'cannot be null'));
    }
    if (!orderId) {
        return reject(parameterError('orderId', 'cannot be null'));
    }
    try {
        const mockReq = {
            query: {
                user_id: userId,
                order_id: orderId
            }
        };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to cancel order');
                }
            }),
            json: (data) => data
        };
        return await cancelOrderUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}
	/**
	 */
async _getOrders(
    opts = {
        user_id: null,
        open: null,
        limit: 50,
        page: 1,
        orderBy: 'created_at',
        order: 'desc',
        format: null
    }
) {
    const queryParams = {};
    if (isNumber(opts.user_id)) queryParams.user_id = opts.user_id;
    if (isBoolean(opts.open)) queryParams.open = String(opts.open);
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        return await getOrdersUtils({ query: queryParams });
    } catch (error) {
        return reject(error);
    }
}

async getOrders(
    opts = {
        symbol: null,
        side: null,
        status: null,
        open: null,
        limit: null,
        page: null,
        orderBy: null,
        order: null,
        startDate: null,
        endDate: null,
        format: null,
        additionalHeaders: null
    }
) {
    console.log('=== getOrders: ');
    const queryParams = {};
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    if (isString(opts.symbol)) queryParams.symbol = opts.symbol;
    if (isString(opts.side)) queryParams.side = opts.side;
    if (isString(opts.status)) queryParams.status = opts.status;
    if (isBoolean(opts.open)) queryParams.open = opts.open;
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data?.error || 'Unknown error');
                }
            }),
            json: (data) => data
        };

        return await getOrdersUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

	/**
	 */
async getUserOrders(
    userId,
    opts = {
        symbol: null,
        side: null,
        status: null,
        open: null,
        limit: 50,
        page: 1,
        orderBy: null,
        order: null,
        startDate: null,
        endDate: null,
        format: 'json',
        additionalHeaders: null
    }
) {
    if (!userId) {
        return reject(parameterError('userId', 'cannot be null'));
    }
    const queryParams = { user_id: userId };
    if (isString(opts.symbol)) queryParams.symbol = opts.symbol;
    if (isString(opts.side)) queryParams.side = opts.side;
    if (isString(opts.status)) queryParams.status = opts.status;
    if (isBoolean(opts.open)) queryParams.open = opts.open;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to fetch orders');
                }
            }),
            json: (data) => data
        };
        return await getUserOrdersUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

	/**
	 */
	cancelAllOrders(userId, opts = {
		symbol: null,
		additionalHeaders: null
	}) {
		if (!userId) {
			return reject(parameterError('userId', 'cannot be null'));
		}

		const verb = 'DELETE';

		let path = `/order/all?user_id=${userId}`;
		if (opts.symbol) {
			path += `&symbol=${opts.symbol}`;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers);
	}

	/**
	 */
async getUserStats(
    userId,
    opts = {
        format: 'json',
        additionalHeaders: null
    }
) {
    if (!userId) {
        return reject(parameterError('userId', 'cannot be null'));
    }
    const queryParams = { user_id: userId };
    if (isString(opts.format)) queryParams.format = opts.format;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to fetch user stats');
                }
            }),
            json: (data) => data
        };
        return await getUserStatsUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}
	/**
	 */
async checkTransaction(
    currency,
    transactionId,
    address,
    network,
    opts = {
        isTestnet: null,
        additionalHeaders: null
    }
) {
    if (!currency) {
        return reject(parameterError('currency', 'cannot be null'));
    }
    if (!transactionId) {
        return reject(parameterError('transactionId', 'cannot be null'));
    }
    if (!address) {
        return reject(parameterError('address', 'cannot be null'));
    }
    if (!network) {
        return reject(parameterError('network', 'cannot be null'));
    }
    const queryParams = {
        currency,
        transaction_id: transactionId,
        address,
        network
    };
    if (isBoolean(opts.isTestnet)) {
        queryParams.is_testnet = opts.isTestnet;
    }
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to check transaction');
                }
            }),
            json: (data) => data
        };

        return await checkTransactionUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}
	/**
	 */
async transferAsset(
    senderId,
    receiverId,
    currency,
    amount,
    opts = {
        transactionId: null,
        description: null,
        email: null,
        category: null,
        additionalHeaders: null
    }
) {
    if (!senderId) return reject(parameterError('senderId', 'cannot be null'));
    if (!receiverId) return reject(parameterError('receiverId', 'cannot be null'));
    if (!currency) return reject(parameterError('currency', 'cannot be null'));
    if (!amount) return reject(parameterError('amount', 'cannot be null'));
    const queryParams = {
        sender_id: senderId,
        receiver_id: receiverId,
        currency,
        amount,
        transaction_id: opts.transactionId || null,
        description: opts.description || null,
        email: isBoolean(opts.email) ? opts.email : true,
        category: opts.category || null
    };
    try {
        const mockReq = { body: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Transfer failed');
                }
            }),
            json: (data) => data
        };
        return await transferAssetUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

	/**
	 */
async getTradesHistory(
    opts = {
        symbol: null,
        side: null,
        limit: 50,
        page: 1,
        orderBy: 'timestamp',
        order: 'desc',
        startDate: null,
        endDate: null,
        additionalHeaders: null
    }
) {
    const queryParams = {};
    if (isString(opts.symbol)) queryParams.symbol = opts.symbol;
    if (isString(opts.side)) queryParams.side = opts.side;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    if (isString(opts.orderBy)) queryParams.order_by = opts.orderBy;
    if (isString(opts.order)) queryParams.order = opts.order;
    if (isDatetime(opts.startDate)) queryParams.start_date = sanitizeDate(opts.startDate);
    if (isDatetime(opts.endDate)) queryParams.end_date = sanitizeDate(opts.endDate);
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to fetch trade history');
                }
            }),
            json: (data) => data
        };
        return await getTradesHistoryUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

	/* Network Engine Endpoints*/

	/**
	 */
async getPublicTrades(
    opts = {
        symbol: null,
        limit: 50,
        page: 1,
        additionalHeaders: null
    }
) {
    const queryParams = {};
    if (isString(opts.symbol)) queryParams.symbol = opts.symbol;
    if (isNumber(opts.limit)) queryParams.limit = opts.limit;
    if (isNumber(opts.page)) queryParams.page = opts.page;
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to fetch public trades');
                }
            }),
            json: (data) => data
        };
        return await getPublicTradesUtils(mockReq, mockRes);
    } catch (error) {
        return reject(error);
    }
}

	/**
	 */
async getOrderbook(symbol, opts = { limit: 50 }) {
    if (!symbol) {
        throw new Error('symbol is required');
    }
    const queryParams = {
        symbol,
        limit: isNumber(opts.limit) ? opts.limit : 50
    };
    try {
        const mockReq = { query: queryParams };
        const mockRes = {
            status: (code) => ({
                json: (data) => {
                    if (code === 200) return data;
                    throw new Error(data.error || 'Failed to fetch orderbook');
                }
            }),
            json: (data) => data
        };
        return await getOrderbookUtils(mockReq, mockRes);
    } catch (err) {
        console.error(`getOrderbook error: ${err.message}`);
        throw err;
    }
}

	/**
	 */
async getOrderbooks(opts = {}) {
    try {
        const mockReq = { query: {} };
        const mockRes = {
            status: () => ({ json: d => d }),
            json: d => d
        };
        return await getOrderbooksUtils(mockReq, mockRes);
    } catch (err) {
        console.error(`getOrderbooks error: ${err.message}`);
        throw err;
    }
}

	/**
	 * Get TradingView trade history HOLCV
	 * @param {string} from - Starting date of trade history in UNIX timestamp format
	 * @param {string} to - Ending date of trade history in UNIX timestamp format
	 * @param {string} symbol - Symbol to get trade history for
	 * @param {string} resolution - Resolution of trade history. 1d, 1W, etc
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with trade history info
	 */
async getChart(from, to, symbol, resolution, opts = { additionalHeaders: null }) {
    if (!from) throw parameterError('from', 'cannot be null');
    if (!to) throw parameterError('to', 'cannot be null');
    if (!symbol) throw parameterError('symbol', 'cannot be null');
    if (!resolution) throw parameterError('resolution', 'cannot be null');
    const isKaspa = symbol.toUpperCase() === 'KAS-USDT';
    if (isKaspa) {
  const url = `https://api.coingecko.com/api/v3/coins/kaspa/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ForkEX-chart-proxy/1.0 (exchange chart proxy)'
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch KAS chart: ${response.status}`);
    }
    const json = await response.json();
    const prices = json.prices || [];
    const volumeMap = new Map((json.total_volumes || []).map((v) => [v[0], v[1]]));
    const formatted = prices.map(item => ({
      time: Math.floor(item[0] / 1000),
      open: item[1],
      high: item[1],
      low: item[1],
      close: item[1],
      volume: volumeMap.get(item[0]) || 0
    }));
    return formatted;
  } catch (error) {
    console.error('❌ Error fetching KAS chart from CoinGecko:', error.message);
    return [];
  }
    } else {
        try {
            const url = `https://api.hollaex.com/v2/chart?symbol=${symbol.toLowerCase()}&resolution=${resolution}&from=${from}&to=${to}`;
            const response = await fetch(url, {
                headers: opts.additionalHeaders || {}
            });
            if (response.ok) {
                const data = await response.json();
                return data.map(item => ({
                    ...item,
                    time: typeof item.time === 'string' ? Math.floor(new Date(item.time).getTime() / 1000) : item.time
                }));
            }
        } catch (_) {}

        // Attempt local DB aggregation from candles table
        try {
            const Sequelize = require('sequelize');
            const { sequelize } = require('../../db/models');
            const { QueryTypes } = Sequelize;

            const resolutionSeconds = resolution === '1D' ? 86400 : resolution === '1W' ? 604800 : resolution === '1h' || resolution === '60' ? 3600 : resolution === '240' ? 14400 : resolution === '120' ? 7200 : resolution === '30' ? 1800 : resolution === '15' ? 900 : resolution === '5' ? 300 : resolution === '1' ? 60 : 86400;
            const tfMap = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '120': '2h', '240': '4h', '1D': '1d', '1W': '1w' };
            const tf = tfMap[resolution] || '5m';

            const candles = await sequelize.query(`
                SELECT timestamp AS open_time, open, high, low, close, volume
                FROM candles
                WHERE pair_id = (SELECT id FROM pairs WHERE symbol = :symbol LIMIT 1)
                  AND timeframe = :tf
                  AND (timestamp >= :from AND timestamp <= :to)
                ORDER BY timestamp ASC
            `, {
                replacements: { symbol, tf, from: Number(from), to: Number(to) },
                type: QueryTypes.SELECT
            });

            if (candles && candles.length > 0) {
                return candles.map(c => ({
                    time: Math.floor(new Date(c.open_time).getTime() / 1000),
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close),
                    volume: parseFloat(c.volume || 0)
                }));
            }
        } catch (_) {}

        // Fallback: aggregate from trades table
        try {
            const Sequelize = require('sequelize');
            const { sequelize } = require('../../db/models');
            const { QueryTypes } = Sequelize;

            const resolutionSeconds = resolution === '1D' ? 86400 : resolution === '1W' ? 604800 : resolution === '1h' || resolution === '60' ? 3600 : resolution === '240' ? 14400 : resolution === '120' ? 7200 : resolution === '30' ? 1800 : resolution === '15' ? 900 : resolution === '5' ? 300 : resolution === '1' ? 60 : 86400;

            const trades = await sequelize.query(`
                SELECT
                    date_trunc('minute', created_at) - interval '1 minute' * (EXTRACT(MINUTE FROM created_at)::int % :tf_min) AS bucket,
                    (array_agg(price ORDER BY created_at ASC))[1] AS open,
                    MAX(price) AS high,
                    MIN(price) AS low,
                    (array_agg(price ORDER BY created_at DESC))[1] AS close,
                    SUM(size) AS volume
                FROM trades
                WHERE symbol = :symbol
                  AND created_at >= to_timestamp(:from)
                  AND created_at <= to_timestamp(:to)
                GROUP BY bucket
                ORDER BY bucket ASC
            `, {
                replacements: { symbol, tf_min: resolutionSeconds / 60, from: Number(from), to: Number(to) },
                type: QueryTypes.SELECT
            });

            if (trades && trades.length > 0) {
                return trades.map(t => ({
                    time: Math.floor(new Date(t.bucket).getTime() / 1000),
                    open: parseFloat(t.open),
                    high: parseFloat(t.high),
                    low: parseFloat(t.low),
                    close: parseFloat(t.close),
                    volume: parseFloat(t.volume || 0)
                }));
            }
        } catch (_) {}

        return [];
    }
}
async getKaspaChartCMC(from, to, resolution) {
  const apiKey = 'e345a5d0-fa67-4f56-be19-a85470f04a38';
  const url = `https://sandbox-api.coinmarketcap.com/v1/cryptocurrency/quotes/historical?symbol=KAS&convert=USDT&interval=${resolution === '1D' ? 'daily' : 'hourly'}&time_start=${from}&time_end=${to}`;
  try {
    const response = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': apiKey
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch KAS chart: ${response.status}`);
    }
    const json = await response.json();
    const points = json.data.quotes || [];
    const formatted = points.map(point => ({
      time: Math.floor(new Date(point.timestamp).getTime() / 1000),
      open: point.quote.USDT.open,
      high: point.quote.USDT.high,
      low: point.quote.USDT.low,
      close: point.quote.USDT.close,
      volume: point.quote.USDT.volume
    }));
    return formatted;
  } catch (error) {
    console.error('❌ Error fetching KAS chart from CMC:', error);
    return [];
  }
}

_2getChart(from, to, symbol, resolution, opts = { additionalHeaders: null }) {
    return new Promise((resolve, reject) => {
        if (!from) return reject(parameterError('from', 'cannot be null'));
        if (!to) return reject(parameterError('to', 'cannot be null'));
        if (!symbol) return reject(parameterError('symbol', 'cannot be null'));
        if (!resolution) return reject(parameterError('resolution', 'cannot be null'));

        let url;
        const isKaspa = symbol.toUpperCase() === 'KAS-USDT';

        if (isKaspa) {
            // CoinGecko endpoint for KASPA
            url = `https://api.coingecko.com/api/v3/coins/kaspa/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
        } else {
            // Default HollaEx chart endpoint
            url = `https://api.hollaex.com/v2/chart?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}`;
        }

        fetch(url, {
            headers: opts.additionalHeaders || {}
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Failed to fetch chart data: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (isKaspa) {
                // Format CoinGecko data to chart format
                const prices = data.prices || [];
                const formatted = prices.map(item => ({
                    time: Math.floor(item[0] / 1000), // ms to sec
                    close: item[1],
                    open: item[1],    // Coingecko doesn't return OHLC, so we fake them
                    high: item[1],
                    low: item[1],
                    volume: 0
                }));
                resolve(formatted);
            } else {
                resolve(data);
            }
        })
        .catch(err => {
            console.error('Error fetching chart data:', err);
            reject(err);
        });
    });
}

_1getChart(from, to, symbol, resolution, opts = { additionalHeaders: null }) {
    return new Promise((resolve, reject) => {
        if (!from) {
            return reject(parameterError('from', 'cannot be null'));
        } else if (!to) {
            return reject(parameterError('to', 'cannot be null'));
        } else if (!symbol) {
            return reject(parameterError('symbol', 'cannot be null'));
        } else if (!resolution) {
            return reject(parameterError('resolution', 'cannot be null'));
        }
        let url;
        if (symbol.toUpperCase() === 'KAS-USDT') {
            url = `https://api.coingecko.com/api/v3/coins/kaspa/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
        } else {
            url = `https://api.hollaex.com/v2/chart?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}`;
        }

        fetch(url, {
            headers: opts.additionalHeaders || {}
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Failed to fetch chart data: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (symbol.toUpperCase() === 'KAS-USDT') {
                const formatted = data.prices.map(item => ({
                    time: Math.floor(item[0] / 1000), // перевести из ms в s
                    close: item[1]
                }));

                resolve(formatted);
            } else {
                resolve(data);
            }
        })
        .catch(err => {
            console.error('Error fetching chart data:', err);
            reject(err);
        });
    });
}

_getChart(from, to, symbol, resolution, opts = { additionalHeaders: null }) {
    return new Promise((resolve, reject) => {
        if (!from) {
            return reject(parameterError('from', 'cannot be null'));
        } else if (!to) {
            return reject(parameterError('to', 'cannot be null'));
        } else if (!symbol) {
            return reject(parameterError('symbol', 'cannot be null'));
        } else if (!resolution) {
            return reject(parameterError('resolution', 'cannot be null'));
        }

        const url = `https://api.hollaex.com/v2/chart?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}`;
        fetch(url, {
            headers: opts.additionalHeaders || {}
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch chart data: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                // Convert ISO time strings to Unix timestamps for TradingView
                const converted = {};
                for (const [symbol, points] of Object.entries(data)) {
                    if (Array.isArray(points)) {
                        converted[symbol] = points.map(item => ({
                            ...item,
                            time: typeof item.time === 'string' ? Math.floor(new Date(item.time).getTime() / 1000) : item.time
                        }));
                    } else {
                        converted[symbol] = points;
                    }
                }
                resolve(converted);
            })
            .catch(err => {
                console.error('Error fetching chart data:', err);
                reject(err);
            });
    });
}

	/**
	 * Get TradingView trade history HOLCV for all pairs
	 * @param {string} from - Starting date of trade history in UNIX timestamp format
	 * @param {string} to - Ending date of trade history in UNIX timestamp format
	 * @param {string} resolution - Resolution of trade history. 1d, 1W, etc
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {array} Array of objects with trade history info
	 */
getCharts(from, to, resolution, opts = {
        additionalHeaders: null
    }) {
    return new Promise((resolve, reject) => {
        if (!from) {
            return reject(parameterError('from', 'cannot be null'));
        } else if (!to) {
            return reject(parameterError('to', 'cannot be null'));
        } else if (!resolution) {
            return reject(parameterError('resolution', 'cannot be null'));
        }
        const url = `https://api.hollaex.com/v2/charts?resolution=${resolution}&from=${from}&to=${to}`;
        fetch(url, {
            headers: opts.additionalHeaders || {}
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch chart data: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                const convertTime = (items) => {
                    return items.map(item => ({
                        ...item,
                        time: typeof item.time === 'string' ? Math.floor(new Date(item.time).getTime() / 1000) : item.time
                    }));
                };
                const result = {};
                for (const [key, val] of Object.entries(data)) {
                    result[key] = Array.isArray(val) ? convertTime(val) : val;
                }
                resolve(result);
            })
            .catch(err => {
                console.error('Error fetching chart data:', err);
                reject(err);
            });
    });
}

	/**
	 * Get mini chart data for different assets
	 * @param {string} assets - The list of assets to get the mini charts for
	 * @param {object} opts - Optional parameters.
	 * @param {string} opts.quote - Quote asset to receive prices based on
	 * @param {string} opts.from - Starting date of trade history in UNIX timestamp format
	 * @param {string} opts.to - Ending date of trade history in UNIX timestamp format
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {array} Array of objects with trade history info
	 */
// Альтернатива: использовать getChart для получения данных для мини-графика
async getMiniCharts(asset, quote = 'usdt', period = '1h') {
    try {
        const symbol = `${asset}-${quote}`.toUpperCase();
        const to = Math.floor(Date.now() / 1000);
        const from = to - 86400; // 24 часа назад
        
        // Используем существующую функцию getChart
        const chartData = await getChart(from, to, symbol, period);
        
        if (Array.isArray(chartData)) {
            // Берем последние 24 точки
            return chartData.slice(-24).map(item => ({
                time: item.time,
                open: item.open,
                high: item.high,
                low: item.low,
                close: item.close,
                volume: item.volume || 0
            }));
        }
        
        return [];
    } catch (error) {
        console.error(`Error getting mini chart for ${asset}:`, error);
        return [];
    }
}
__getMiniCharts(assets, opts = {
    from: null,
    to: null,
    quote: null,
    period: null,
    additionalHeaders: null
}) {
    return new Promise((resolve, reject) => {
        if (!assets) { 
            return reject(parameterError('assets', 'cannot be null')); 
        }
        // Используем ваш API endpoint вместо оригинального Hollaex
        let path = `/api/v2/minicharts?assets=${assets}`;
        // Добавляем параметры если они есть
        const params = new URLSearchParams();
        params.append('assets', assets);
        if (opts.from) { params.append('from', opts.from); }
        if (opts.to) { params.append('to', opts.to); }
        if (opts.quote) { params.append('quote', opts.quote); }
        if (opts.period) { params.append('period', opts.period); }
        // Формируем полный URL
        const queryString = params.toString();
        path = `/api/v2/minicharts?${queryString}`;
        fetch(path, {
            headers: {
                'Content-Type': 'application/json',
                ...(opts.additionalHeaders || {})
            }
        })
        .then(response => {
            if (!response.ok) {
                // Пробуем получить больше информации об ошибке
                return response.text().then(text => {
                    let errorMessage = `Failed to fetch chart data: ${response.status}`;
                    try {
                        const errorData = JSON.parse(text);
                        if (errorData.message) {
                            errorMessage += ` - ${errorData.message}`;
                        }
                    } catch (e) {
                        if (text) {
                            errorMessage += ` - ${text}`;
                        }
                    }
                    throw new Error(errorMessage);
                });
            }
            return response.json();
        })
            .then(data => {
                const convertTime = (items) => {
                    return items.map(item => ({
                        ...item,
                        time: typeof item.time === 'string' ? Math.floor(new Date(item.time).getTime() / 1000) : item.time
                    }));
                };
                const chartData = data && data.success ? data.data : data;
                const result = {};
                for (const [key, val] of Object.entries(chartData)) {
                    result[key] = Array.isArray(val) ? convertTime(val) : val;
                }
                resolve(result);
            })
        .catch(err => {
            console.error('Error fetching chart data:', err);
            reject(err);
        });
    });
}
_getMiniCharts(assets, opts = {
        from: null,
        to: null,
        quote: null,
        period: null,
        additionalHeaders: null
    }) {
    return new Promise((resolve, reject) => {
        if (!assets) { return reject(parameterError('assets', 'cannot be null')); }
        let path = `https://api.hollaex.com/v2/minicharts?assets=${assets}`;
        if (opts.from  ) {path += `&from=${opts.from}`;}
        if (opts.to    ) {path += `&to=${opts.to}`;}
        if (opts.quote ) {path += `&quote=${opts.quote}`;}
        if (opts.period) {path += `&period=${opts.period}`;}
        fetch(path, {
            headers: opts.additionalHeaders || {}
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch chart data: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                resolve(data);
            })
            .catch(err => {
                console.error('Error fetching chart data:', err);
                reject(err);
            });
    });
}
	/**
	 * Get TradingView udf config
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with TradingView udf config
	 */
async getUdfConfig(opts = {
    additionalHeaders: null
}) {
    console.log('===getUdfConfig: using local data');
    // Локальные данные для TradingView
    const localConfig = {
        "supports_search": true,
        "supports_group_request": false,
        "supports_marks": false,
        "supports_timescale_marks": false,
        "supports_time": true,
        "exchanges": [
            {
                "value": "FORKEX",
                "name": "Fork Exchange",
                "desc": "Fork Exchange"
            }
        ],
        "symbols_types": [
            {
                "name": "All types",
                "value": ""
            },
            {
                "name": "Crypto",
                "value": "crypto"
            }
        ],
        "supported_resolutions": ["1", "5", "15", "30", "60", "240", "D", "W"],
        "supports_marks": true,
        "supports_time": true,
        "supports_timescale_marks": true
    };
    return localConfig;
}
	/**
	 * Get TradingView udf history HOLCV
	 * @param {string} from - Starting date in UNIX timestamp format
	 * @param {string} to - Ending date in UNIX timestamp format
	 * @param {string} symbol - Symbol to get
	 * @param {string} resolution - Resolution of query. 1d, 1W, etc
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with TradingView udf history HOLCV
	 */
async getUdfHistory(from, to, symbol, resolution, opts = {
    additionalHeaders: null
}) {
    if (!from || !to || !symbol || !resolution) {
        return Promise.reject(parameterError('missing parameter', 'cannot be null'));
    }

    try {
        const Sequelize = require('sequelize');
        const { sequelize } = require('../../db/models');
        const { QueryTypes } = Sequelize;

        const resolutionSeconds = resolution === '1D' ? 86400 : resolution === '1W' ? 604800 : resolution === '1h' || resolution === '60' ? 3600 : resolution === '240' ? 14400 : resolution === '120' ? 7200 : resolution === '30' ? 1800 : resolution === '15' ? 900 : resolution === '5' ? 300 : resolution === '1' ? 60 : 86400;

        const trades = await sequelize.query(`
            SELECT
                date_trunc('minute', created_at) - interval '1 minute' * (EXTRACT(MINUTE FROM created_at)::int % :tf_min) AS bucket,
                (array_agg(price ORDER BY created_at ASC))[1] AS open,
                MAX(price) AS high,
                MIN(price) AS low,
                (array_agg(price ORDER BY created_at DESC))[1] AS close,
                SUM(size) AS volume
            FROM trades
            WHERE symbol = :symbol
              AND created_at >= to_timestamp(:from)
              AND created_at <= to_timestamp(:to)
            GROUP BY bucket
            ORDER BY bucket ASC
        `, {
            replacements: { symbol, tf_min: resolutionSeconds / 60, from: Number(from), to: Number(to) },
            type: QueryTypes.SELECT
        });

        if (trades && trades.length > 0) {
            const s = 'ok';
            const t = trades.map(tr => Math.floor(new Date(tr.bucket).getTime() / 1000));
            const o = trades.map(tr => String(tr.open));
            const h = trades.map(tr => String(tr.high));
            const l = trades.map(tr => String(tr.low));
            const c = trades.map(tr => String(tr.close));
            const v = trades.map(tr => String(tr.volume || 0));
            return { s, t, o, h, l, c, v };
        }
    } catch (_) {}

    return { s: 'no_data', t: [], o: [], h: [], l: [], c: [], v: [] };
}
_getUdfHistory(from, to, symbol, resolution, opts = {
    additionalHeaders: null
}) {
    console.log('===getUdfHistory: local mode for', symbol);
    // Простые данные чтобы график отображался
    const interval = 300; // 5 минут в секундах
    const count = 10;
    const t = [];
    const c = [];
    const o = [];
    const h = [];
    const l = [];
    const v = [];
    let price = 100;
    for (let i = 0; i < count; i++) {
        t.push(from + (i * interval));
        const open = price;
        const change = (Math.random() - 0.5) * 2;
        const close = open + change;
        const high = Math.max(open, close) + Math.random();
        const low = Math.min(open, close) - Math.random();
        o.push(open.toFixed(8));
        h.push(high.toFixed(8));
        l.push(low.toFixed(8));
        c.push(close.toFixed(8));
        v.push((Math.random() * 1000).toFixed(2));
        price = close;
    }
    return Promise.resolve({
        s: "ok",
        t: t,
        c: c,
        o: o,
        h: h,
        l: l,
        v: v,
        nextTime: t[t.length - 1] + interval
    });
}
	/**
	 * Get TradingView udf symbols
	 * @param {string} symbol - Symbol to get
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with TradingView udf symbols
	 */
	__getUdfSymbols(symbol, opts = {
		additionalHeaders: null
	}) {
		if (!symbol) {
			return reject(parameterError('symbol', 'cannot be null'));
		}

		const verb = 'GET';
		const path = `/udf/symbols?symbol=${symbol}`;
		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers);
	}
getUdfSymbols(symbol, opts = {
    additionalHeaders: null
}) {
    if (!symbol) {
        return Promise.reject(parameterError('symbol', 'cannot be null'));
    }
    
    console.log('===getUdfSymbols: returning local config for', symbol);
    
    // Минимальный набор данных для работы TradingView
    return Promise.resolve({
        "name": symbol.replace('/', ''),
        "exchange-traded": "EXCHANGE",
        "exchange-listed": "EXCHANGE",
        "timezone": "UTC",
        "minmov": 1,
        "minmov2": 0,
        "pointvalue": 1,
        "session": "24x7",
        "has_intraday": true,
        "has_no_volume": false,
        "description": symbol,
        "type": "crypto",
        "supported_resolutions": ["1", "5", "15", "30", "60", "240", "D", "W"],
        "pricescale": 100,
        "ticker": symbol.replace('/', ''),
        "data_status": "streaming"
    });
}
/**
 */
async getTicker(symbol, opts = {}) {
    if (!symbol) { symbol = "xht-usdt"; }
    if (symbol && !symbol.includes('-') && !symbol.includes('/')) { symbol = symbol + "-usdt"; }
    try {
        // Проверяем обязательные параметры
        if (!symbol || typeof symbol !== 'string') {
            throw new Error('Symbol parameter is required and must be a string');
        }
        // Используем локальную утилиту
        const { getTickerUtils } = require('../getTickerUtils');
        const tickerData = await getTickerUtils(symbol);
        // Форматируем ответ в стиле Hollaex API
        const formattedTicker = this.formatTickerResponse(tickerData);
        return formattedTicker;
    } catch (error) {
        console.error(`Error in NetworkLib.getTicker for ${symbol}:`, error.message);
        if (error.message && error.message.includes('Unknown symbol')) {
            throw error;
        }
        // Fallback на базовые данные
        return this.getFallbackTicker(symbol);
    }
}
formatTickerResponse(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid ticker data');
    }
    const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
    const ts =
        data.timestamp
            ? new Date(data.timestamp).toISOString()
            : data.time
                ? new Date(data.time).toISOString()
                : new Date().toISOString();
    return {
        symbol: String(data.symbol),
        open: num(data.open),
        close: num(data.close),
        high: num(data.high),
        low: num(data.low),
        last: num(data.last),
        volume: num(data.volume),
        timestamp: ts
    };
}
getFallbackTicker(symbol) {
    const [base] = symbol.split('-');
    const manualPrices = {
        xht: 0.5,
        brics: 1.3,
        btm: 0.05,
        gor: 0.07,
        cas: 0.12,
        kasv2: 0.075,
    };

    const price = manualPrices[base] ?? 0;

    return {
        symbol,
        open: price,
        close: price,
        high: price,
        low: price,
        last: price,
        volume: 0,
        timestamp: new Date().toISOString()
    };
}
/**
 */
    async getTickers(opts = {}) {
        console.log('NetworkLib.getTickers called with options:', opts);
        try {
            // forceRefresh можно передать в опциях
            const { getTickersUtils } = require('../getTickersUtils');
            const forceRefresh = opts.forceRefresh || false;
            const tickers = await getTickersUtils(forceRefresh);
            // Логируем результат
            console.log(`2.Returning ${Object.keys(tickers).length} tickers`);
            return tickers;
        } catch (error) {
            console.error('Error in NetworkLib.getTickers:', error.message);
            // Fallback к оригинальному методу или базовым данным
            if (this.originalGetTickers) {
                return this.originalGetTickers.call(this, opts);
            }
            // Возвращаем базовые данные
            const { getBasicTickers } = require('../getTickersUtilsV2');
            return getBasicTickers();
        }
    }

	/**
	 * Mint an asset you own to a user
	 * @param {number} userId; - Network id of user.
	 * @param {string} currency - Currency to mint.
	 * @param {number} amount - Amount to mint.
	 * @param {object} opts - Optional parameters.
	 * @param {string} opts.description - Description of transfer.
	 * @param {string} opts.transactionId - Custom transaction ID for mint.
	 * @param {string} opts.address - Custom address for mint.
	 * @param {boolean} opts.status - Status of mint created. Default: true.
	 * @param {boolean} opts.email - Send email notification to user. Default: true.
	 * @param {number} opts.fee - Optional fee to display in data.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with created mint's data.
	 */
	mintAsset(userId, currency, amount, opts = {
		description: null,
		transactionId: null,
		address: null,
		status: true,
		dismissed: false,
		rejected: false,
		waiting: false,
		email: true,
		fee: null,
		additionalHeaders: null
	}) {
		if (!userId) {
			return reject(parameterError('userId', 'cannot be null'));
		} else if (!currency) {
			return reject(parameterError('currency', 'cannot be null'));
		} else if (!amount) {
			return reject(parameterError('amount', 'cannot be null'));
		}

		const verb = 'POST';
                const path = `/mint`;
		const data = {
			user_id: userId,
			currency,
			amount
		};

		if (opts.description) {
			data.description = opts.description;
		}

		if (opts.transactionId) {
			data.transaction_id = opts.transactionId;
		}

		if (opts.address) {
			data.address = opts.address;
		}

		if (isBoolean(opts.status)) {
			data.status = opts.status;
		} else {
			data.status = true;
		}

		if (isBoolean(opts.rejected)) {
			data.rejected = opts.rejected;
		} else {
			data.rejected = false;
		}

		if (isBoolean(opts.dismissed)) {
			data.dismissed = opts.dismissed;
		} else {
			data.dismissed = false;
		}

		if (isBoolean(opts.waiting)) {
			data.waiting = opts.waiting;
		} else {
			data.waiting = false;
		}

		if (isBoolean(opts.email)) {
			data.email = opts.email;
		} else {
			data.email = true;
		}

		if (isNumber(opts.fee)) {
			data.fee = opts.fee;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Update a pending mint
	 * @param {string} transactionId; - Transaction ID of pending mint.
	 * @param {object} opts - Optional parameters.
	 * @param {boolean} opts.status - Set to true to confirm pending mint.
	 * @param {boolean} opts.dismissed - Set to true to dismiss pending mint.
	 * @param {boolean} opts.rejected - Set to true to reject pending mint.
	 * @param {boolean} opts.processing - Set to true to set state to processing.
	 * @param {boolean} opts.waiting - Set to true to set state to waiting.
	 * @param {string} opts.updatedTransactionId - Value to update transaction ID of pending mint to.
	 * @param {string} opts.updatedAddress - Value to update address of pending mint to.
	 * @param {boolean} opts.email - Send email notification to user. Default: true.
	 * @param {string} opts.updatedDescription - Value to update transaction description to.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with updated mint's data.
	 */
	updatePendingMint(
		transactionId,
		opts = {
			status: null,
			dismissed: null,
			rejected: null,
			processing: null,
			waiting: null,
			updatedTransactionId: null,
			updatedAddress: null,
			email: true,
			updatedDescription: null,
			additionalHeaders: null
		}
	) {
		if (!transactionId) {
			return reject(parameterError('transactionId', 'cannot be null'));
		}

		const status = isBoolean(opts.status) ? opts.status : false;
		const rejected = isBoolean(opts.rejected) ? opts.rejected : false;
		const dismissed = isBoolean(opts.dismissed) ? opts.dismissed : false;
		const processing = isBoolean(opts.processing) ? opts.processing : false;
		const waiting = isBoolean(opts.waiting) ? opts.waiting : false;

		if (
			status && (rejected || dismissed || processing || waiting)
			|| rejected && (status || dismissed || processing || waiting)
			|| dismissed && (status || rejected || processing || waiting)
			|| processing && (status || dismissed || rejected || waiting)
			|| waiting && (status || rejected || dismissed || processing)
		) {
			return reject(new Error('Can only update one parmaeter'));
		}

		const verb = 'PUT';
                const path = `/mint`;

		const data = {
			transaction_id: transactionId,
			status,
			rejected,
			dismissed,
			processing,
			waiting
		};

		if (opts.updatedTransactionId) {
			data.updated_transaction_id = opts.updatedTransactionId;
		}

		if (opts.updatedAddress) {
			data.updated_address = opts.updatedAddress;
		}

		if (opts.updatedDescription) {
			data.updated_description = opts.updatedDescription;
		}

		if (isBoolean(opts.email)) {
			data.email = opts.email;
		} else {
			data.email = true;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Burn an asset you own to a user
	 * @param {number} userId; - Network id of user.
	 * @param {string} currency - Currency to burn.
	 * @param {number} amount - Amount to burn.
	 * @param {object} opts - Optional parameters.
	 * @param {string} opts.description - Description of transfer.
	 * @param {string} opts.transactionId - Custom transaction ID for burn.
	 * @param {string} opts.address - Custom address for burn.
	 * @param {boolean} opts.status - Status of burn created. Default: true.
	 * @param {boolean} opts.email - Send email notification to user. Default: true.
	 * @param {number} opts.fee - Optional fee to display in data.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with created burn's data.
	 */
	burnAsset(userId, currency, amount, opts = {
		description: null,
		transactionId: null,
		address: null,
		status: true,
		dismissed: false,
		rejected: false,
		waiting: false,
		email: true,
		fee: null,
		additionalHeaders: null
	}) {
		if (!userId) {
			return reject(parameterError('userId', 'cannot be null'));
		} else if (!currency) {
			return reject(parameterError('currency', 'cannot be null'));
		} else if (!amount) {
			return reject(parameterError('amount', 'cannot be null'));
		}

		const verb = 'POST';
                const path = `/burn`;

		const data = {
			user_id: userId,
			currency,
			amount
		};

		if (opts.description) {
			data.description = opts.description;
		}

		if (opts.transactionId) {
			data.transaction_id = opts.transactionId;
		}

		if (opts.address) {
			data.address = opts.address;
		}

		if (isBoolean(opts.status)) {
			data.status = opts.status;
		} else {
			data.status = true;
		}

		if (isBoolean(opts.rejected)) {
			data.rejected = opts.rejected;
		} else {
			data.rejected = false;
		}

		if (isBoolean(opts.dismissed)) {
			data.dismissed = opts.dismissed;
		} else {
			data.dismissed = false;
		}

		if (isBoolean(opts.waiting)) {
			data.waiting = opts.waiting;
		} else {
			data.waiting = false;
		}

		if (isBoolean(opts.email)) {
			data.email = opts.email;
		} else {
			data.email = true;
		}

		if (isNumber(opts.fee)) {
			data.fee = opts.fee;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Update a pending burn
	 * @param {string} transactionId; - Transaction ID of pending burn.
	 * @param {object} opts - Optional parameters.
	 * @param {boolean} opts.status - Set to true to confirm pending burn.
	 * @param {boolean} opts.dismissed - Set to true to dismiss pending burn.
	 * @param {boolean} opts.rejected - Set to true to reject pending burn.
	 * @param {boolean} opts.processing - Set to true to set state to processing.
	 * @param {boolean} opts.waiting - Set to true to set state to waiting.
	 * @param {string} opts.updatedTransactionId - Value to update transaction ID of pending burn to.
	 * @param {string} opts.updatedAddress - Value to update address of pending burn to.
	 * @param {boolean} opts.email - Send email notification to user. Default: true.
	 * @param {string} opts.updatedDescription - Value to update transaction description to.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with updated burn's data.
	 */
	updatePendingBurn(
		transactionId,
		opts = {
			status: null,
			dismissed: null,
			rejected: null,
			processing: null,
			waiting: null,
			updatedTransactionId: null,
			updatedAddress: null,
			email: true,
			updatedDescription: null,
			additionalHeaders: null
		}
	) {
		if (!transactionId) {
			return reject(parameterError('transactionId', 'cannot be null'));
		}

		const status = isBoolean(opts.status) ? opts.status : false;
		const rejected = isBoolean(opts.rejected) ? opts.rejected : false;
		const dismissed = isBoolean(opts.dismissed) ? opts.dismissed : false;
		const processing = isBoolean(opts.processing) ? opts.processing : false;
		const waiting = isBoolean(opts.waiting) ? opts.waiting : false;

		if (
			status && (rejected || dismissed || processing || waiting)
			|| rejected && (status || dismissed || processing || waiting)
			|| dismissed && (status || rejected || processing || waiting)
			|| processing && (status || dismissed || rejected || waiting)
			|| waiting && (status || rejected || dismissed || processing)
		) {
			return reject(new Error('Can only update one parmaeter'));
		}

		const verb = 'PUT';
                const path = `/burn`;

		const data = {
			transaction_id: transactionId,
			status,
			rejected,
			dismissed,
			processing,
			waiting
		};

		if (opts.updatedTransactionId) {
			data.updated_transaction_id = opts.updatedTransactionId;
		}

		if (opts.updatedAddress) {
			data.updated_address = opts.updatedAddress;
		}

		if (opts.updatedDescription) {
			data.updated_description = opts.updatedDescription;
		}

		if (isBoolean(opts.email)) {
			data.email = opts.email;
		} else {
			data.email = true;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Get generated fees for exchange
	 * @param {object} opts - Optional parameters.
	 * @param {string} opts.startDate - Start date of query in ISO8601 format.
	 * @param {string} opts.endDate - End date of query in ISO8601 format.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with generated fees
	 */
	async getGeneratedFees(
		opts = {
			startDate: null,
			endDate: null,
			additionalHeaders: null
		}
	) {
		const { Trade, sequelize } = require('../../db/models');
		const { Op } = require('sequelize');

		const where = {};
		if (isDatetime(opts.startDate) && isDatetime(opts.endDate)) {
			where.timestamp = { [Op.between]: [new Date(opts.startDate), new Date(opts.endDate)] };
		} else if (isDatetime(opts.startDate)) {
			where.timestamp = { [Op.gte]: new Date(opts.startDate) };
		} else if (isDatetime(opts.endDate)) {
			where.timestamp = { [Op.lte]: new Date(opts.endDate) };
		}

		const rows = await Trade.findAll({
			where,
			attributes: [
				'maker_fee_coin',
				'taker_fee_coin',
				[sequelize.fn('SUM', sequelize.col('maker_fee')), 'maker_fee_total'],
				[sequelize.fn('SUM', sequelize.col('taker_fee')), 'taker_fee_total']
			],
			group: ['maker_fee_coin', 'taker_fee_coin'],
			raw: true
		});

		const fees = {};
		for (const row of rows) {
			if (row.maker_fee_coin) {
				fees[row.maker_fee_coin] = (fees[row.maker_fee_coin] || 0) + Number(row.maker_fee_total || 0);
			}
			if (row.taker_fee_coin) {
				fees[row.taker_fee_coin] = (fees[row.taker_fee_coin] || 0) + Number(row.taker_fee_total || 0);
			}
		}

		return {
			start_date: isDatetime(opts.startDate) ? opts.startDate : null,
			end_date: isDatetime(opts.endDate) ? opts.endDate : null,
			fees
		};
	}

	/**
	 * Settle exchange fees
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.user_id - user id that receives the fee earnings.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with settled fees.
	 */
	settleFees(opts = {
		user_id: null,
		additionalHeaders: null
	}) {
		const verb = 'GET';

                let path = `/fees/settle?`;

		if (opts.user_id) {
			path += `&user_id=${opts.user_id}`;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers);
	}

	/**
	 * Convert assets to a quote asset
	 * @param {array} assets - Array of assets to convert as strings
	 * @param {object} opts - Optional parameters.
	 * @param {string} opts.quote - Quote asset to convert to. Default: usdt.
	 * @param {number} opts.amount - Amount of quote asset to convert to. Default: 1.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with converted assets.
	 */
async getOraclePrices(assets = [], opts = {}) {
    try {
        const mockReq = {
            query: {
                assets,
                quote: opts.quote || 'usdt',
                amount: opts.amount || 1
            }
        };
        const mockRes = {
            status: () => ({ json: d => d }),
            json: d => d
        };
        return await getOraclePricesUtils(mockReq, mockRes);
    } catch (err) {
        console.error(`getOraclePrices error: ${err.message}`);
        throw err;
    }
}

	getConstants(opts = {
		additionalHeaders: null
	}) {
		const {
			GET_COINS,
			GET_PAIRS,
			GET_BROKER,
			GET_QUICKTRADE,
			GET_TRANSACTION_LIMITS,
			GET_NETWORK_QUICKTRADE,
			HOLLAEX_NETWORK_ENDPOINT
		} = require('../../constants');

		return Promise.resolve({
			coins: GET_COINS(),
			pairs: GET_PAIRS(),
			broker: GET_BROKER(),
			quicktrade: GET_QUICKTRADE(),
			transactionLimits: GET_TRANSACTION_LIMITS(),
			networkQuickTrades: GET_NETWORK_QUICKTRADE(),
			network: HOLLAEX_NETWORK_ENDPOINT
		});
	}

	getExchange(opts = {
		additionalHeaders: null
	}) {
		const { Status, Coin, Pair } = require('../../db/models');
		return Promise.all([
			Status.findOne({ attributes: ['id', 'name', 'url', 'constants', 'kit', 'email'] }),
			Coin.findAll({ where: { is_public: true, active: true } }),
			Pair.findAll({ where: { active: true, is_public: true } })
		]).then(([status, coins, pairs]) => {
			if (!status) throw new Error('Exchange not initialized');
			return {
				id: status.id,
				name: status.name || 'ForkEX',
				display_name: status.name || 'ForkEX',
				url: status.url || process.env.PUBLIC_API_URL || 'https://forkex.life',
				info: status.constants || {},
				pairs: pairs.map(p => ({ name: p.name, symbol: p.symbol, active: p.active })),
				coins: coins.map(c => ({ symbol: c.symbol, fullname: c.fullname, code: c.code })),
				kit: status.kit || {}
			};
		});
	}

	updateExchange(
		fields = {
			info: null,
			isPublic: null,
			type: null,
			name: null,
			displayName: null,
			url: null,
			businessInfo: null,
			pairs: null,
			coins: null
		},
		opts = {
			additionalHeaders: null
		}
	) {
		const verb = 'PUT';
		const path = `${this.baseUrl}/exchange`;

		const data = {
			id: this.exchange_id
		};

		if (isPlainObject(fields.info)) {
			data.info = fields.info;
		}

		if (isBoolean(fields.isPublic)) {
			data.is_public = fields.isPublic;
		}

		if (isString(fields.type) && ['DIY', 'Cloud', 'Enterprise'].includes(fields.type)) {
			data.type = fields.type;
		}

		if (isString(fields.name)) {
			data.name = fields.name;
		}

		if (isString(fields.displayName)) {
			data.display_name = fields.displayName;
		}

		if (isString(fields.url)) {
			data.url = fields.url;
		}

		if (isPlainObject(fields.businessInfo)) {
			data.business_info = fields.businessInfo;
		}

		if (isArray(fields.pairs) && !fields.pairs.some((pair) => !isString(pair))) {
			data.pairs = fields.pairs;
		}

		if (isArray(fields.coins) && !fields.coins.some((coin) => !isString(coin))) {
			data.coins = fields.coins;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	async getAllCoins(
		opts = {
			additionalHeaders: null
		}
	) {
		const { Coin } = require('../../db/models');
		const coins = await Coin.findAll({ order: [['id', 'ASC']] });

		return coins.map(c => ({
			id: c.id,
			symbol: c.symbol,
			fullname: c.fullname,
			code: c.code,
			withdrawal_fee: c.withdrawal_fee,
			min: c.min,
			max: c.max,
			increment_unit: c.increment_unit,
			allow_deposit: c.allow_deposit,
			allow_withdrawal: c.allow_withdrawal,
			network: c.network,
			type: c.type,
			is_risky: c.is_risky,
			active: c.active,
			verified: c.verified
		}));
	}

	createCoin(
		symbol,
		fullname,
		opts = {
			code: null,
			withdrawalFee: null,
			min: null,
			max: null,
			incrementUnit: null,
			logo: null,
			meta: null,
			estimatedPrice: null,
			type: null,
			network: null,
			standard: null,
			allowDeposit: null,
			allowWithdrawal: null,
			additionalHeaders: null
		}
	) {
		if (!isString(symbol)) {
			return reject(parameterError('symbol', 'cannot be null'));
		} else if (!isString(fullname)) {
			return reject(parameterError('fullname', 'cannot be null'));
		}

		const verb = 'POST';
		const path = `${this.baseUrl}/coin`;
		const data = {
			symbol,
			fullname
		};

		if (isString(opts.code)) {
			data.code = opts.code;
		}

		if (isNumber(opts.withdrawalFee) && opts.withdrawalFee >= 0) {
			data.withdrawal_fee = opts.withdrawalFee;
		}

		if (isNumber(opts.min)) {
			data.min = opts.min;
		}

		if (isNumber(opts.max)) {
			data.max = opts.max;
		}

		if (isNumber(opts.incrementUnit) && opts.incrementUnit >= 0) {
			data.increment_unit = opts.incrementUnit;
		}

		if (isUrl(opts.logo)) {
			data.logo = opts.logo;
		}

		if (isPlainObject(opts.meta)) {
			data.meta = opts.meta;
		}

		if (isNumber(opts.estimatedPrice) && opts.estimatedPrice >= 0) {
			data.estimated_price = opts.estimatedPrice;
		}

		if (isString(opts.type) && ['blockchain', 'fiat', 'other'].includes(opts.type)) {
			data.type = opts.type;
		}

		if (isString(opts.network)) {
			data.network = opts.network;
		}

		if (isString(opts.standard)) {
			data.standard = opts.standard;
		}

		if (isBoolean(opts.allowDeposit)) {
			data.allow_deposit = opts.allowDeposit;
		}

		if (isBoolean(opts.allowWithdrawal)) {
			data.allow_withdrawal = opts.allowWithdrawal;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	getCoins (
		opts = {
			search: null,
			additionalHeaders: null
		}
	) {
		const { Coin } = require('../../db/models');
		const { Op } = require('sequelize');
		const where = { is_public: true, active: true };
		if (isString(opts.search)) {
			where[Op.or] = [
				{ symbol: { [Op.iLike]: `%${opts.search}%` } },
				{ fullname: { [Op.iLike]: `%${opts.search}%` } }
			];
		}
		return Coin.findAll({ where, order: [['id', 'ASC']] }).then(coins => {
			return coins.map(c => ({
				id: c.id,
				symbol: c.symbol,
				fullname: c.fullname,
				code: c.code,
				withdrawal_fee: c.withdrawal_fee,
				min: c.min,
				max: c.max,
				increment_unit: c.increment_unit,
				allow_deposit: c.allow_deposit,
				allow_withdrawal: c.allow_withdrawal,
				network: c.network,
				type: c.type,
				is_risky: c.is_risky,
				active: c.active,
				verified: c.verified
			}));
		});
	}

	updateCoin(
		code,
		fields = {
			fullname: null,
			withdrawalFee: null,
			description: null,
			withdrawalFees: null,
			depositFees: null,
			min: null,
			max: null,
			isPublic: null,
			incrementUnit: null,
			logo: null,
			meta: null,
			estimatedPrice: null,
			type: null,
			network: null,
			standard: null,
			allowDeposit: null,
			allowWithdrawal: null
		},
		opts = {
			additionalHeaders: null
		}
	) {
		if (!isString(code)) {
			return reject(parameterError('code', 'cannot be null'));
		}

		if (isEmpty(fields)) {
			return reject(parameterError('fields', 'cannot be empty'));
		}

		const verb = 'PUT';
                const path = `/coin`;

		const data = {};

		for (const field in fields) {
			const value = fields[field];
			const formattedField = snakeCase(field);

			switch (field) {
				case 'type':
					if (['blockchain', 'fiat', 'other'].includes(value)) {
						data[formattedField] = value;
					}
					break;
				case 'fullname':
				case 'description':
				case 'network':
				case 'standard':
					if (isString(value)) {
						data[formattedField] = value;
					}
					break;
				case 'withdrawalFee':
				case 'min':
				case 'max':
				case 'incrementUnit':
				case 'estimatedPrice':
					if (isNumber(value)) {
						data[formattedField] = value;
					}
					break;
				case 'isPublic':
				case 'allowDeposit':
				case 'allowWithdrawal':
					if (isBoolean(value)) {
						data[formattedField] = value;
					}
					break;
				case 'logo':
					if (isUrl(value)) {
						data[formattedField] = value;
					}
					break;
				case 'meta':
				case 'withdrawalFees':
					if (isPlainObject(value)) {
						data[formattedField] = value;
					}
					break;
				case 'depositFees':
					if (isPlainObject(value)) {
						data[formattedField] = value;
					}
					break;
				default:
					break;
			}
		}

		if (isEmpty(data)) {
			return reject(new Error('No updatable fields given'));
		}

		data.code = code;

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	async getAllPairs(
		opts = {
			additionalHeaders: null
		}
	) {
		const { Pair } = require('../../db/models');
		const pairs = await Pair.findAll({ order: [['id', 'ASC']] });

		return pairs.map(p => ({
			id: p.id,
			name: p.name,
			symbol: p.symbol,
			active: p.active,
			increment_price: p.increment_price,
			increment_size: p.increment_size,
			min_price: p.min_price,
			max_price: p.max_price,
			min_size: p.min_size,
			max_size: p.max_size
		}));
	}

	createPair(
		name,
		baseCoin,
		quoteCoin,
		opts = {
			code: null,
			active: null,
			minSize: null,
			maxSize: null,
			minPrice: null,
			maxPrice: null,
			incrementSize: null,
			incrementPrice: null,
			estimatedPrice: null,
			isPublic: null,
			additionalHeaders: null
		}
	) {
		if (!isString(name)) {
			return reject(parameterError('symbol', 'cannot be null'));
		} else if (!isString(baseCoin)) {
			return reject(parameterError('baseCoin', 'cannot be null'));
		} else if (!isString(quoteCoin)) {
			return reject(parameterError('quoteCoin', 'cannot be null'));
		}

		const verb = 'POST';
                const path = `/pair`;

		const data = {
			name,
			pair_base: baseCoin,
			pair_2: quoteCoin
		};

		if (isString(opts.code)) {
			data.code = opts.code;
		}

		if (isBoolean(opts.active)) {
			data.active = opts.active;
		}

		if (isNumber(opts.minSize)) {
			data.min_size = opts.minSize;
		}

		if (isNumber(opts.maxSize)) {
			data.max_size = opts.maxSize;
		}

		if (isNumber(opts.minPrice)) {
			data.min_price = opts.minPrice;
		}

		if (isNumber(opts.maxPrice)) {
			data.max_price = opts.maxPrice;
		}

		if (isNumber(opts.incrementSize) && opts.incrementSize >= 0) {
			data.increment_size = opts.incrementSize;
		}

		if (isNumber(opts.incrementPrice) && opts.incrementPrice >= 0) {
			data.increment_price = opts.incrementPrice;
		}

		if (isNumber(opts.estimatedPrice) && opts.estimatedPrice >= 0) {
			data.estimated_price = opts.estimatedPrice;
		}

		if (isNumber(opts.incrementUnit) && opts.incrementUnit >= 0) {
			data.increment_unit = opts.incrementUnit;
		}

		if (isBoolean(opts.isPublic)) {
			data.is_public = opts.isPublic;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	getPairs (
		opts = {
			search: null,
			additionalHeaders: null
		}
	) {
		const { Pair } = require('../../db/models');
		const { Op } = require('sequelize');
		const where = { active: true, is_public: true };
		if (isString(opts.search)) {
			where[Op.or] = [
				{ name: { [Op.iLike]: `%${opts.search}%` } },
				{ symbol: { [Op.iLike]: `%${opts.search}%` } }
			];
		}
		return Pair.findAll({ where, order: [['id', 'ASC']] }).then(pairs => {
			return pairs.map(p => ({
				id: p.id,
				name: p.name,
				symbol: p.symbol,
				active: p.active,
				increment_price: p.increment_price,
				increment_size: p.increment_size,
				min_price: p.min_price,
				max_price: p.max_price,
				min_size: p.min_size,
				max_size: p.max_size
			}));
		});
	}

	updatePair(
		code,
		fields = {
			minSize: null,
			maxSize: null,
			minPrice: null,
			maxPrice: null,
			incrementSize: null,
			incrementPrice: null,
			estimatedPrice: null,
			isPublic: null,
			circuitBreaker: null
		},
		opts = {
			additionalHeaders: null
		}
	) {
		if (!isString(code)) {
			return reject(parameterError('code', 'cannot be null'));
		}

		if (isEmpty(fields)) {
			return reject(parameterError('fields', 'cannot be empty'));
		}

		const verb = 'PUT';
                const path = `/pair`;

		const data = {};

		for (const field in fields) {
			const value = fields[field];
			const formattedField = snakeCase(field);

			switch (field) {
				case 'minSize':
				case 'maxSize':
				case 'minPrice':
				case 'maxPrice':
				case 'incrementSize':
				case 'incrementPrice':
				case 'estimatedPrice':
					if (isNumber(value)) {
						data[formattedField] = value;
					}
					break;
				case 'isPublic':
				case 'circuitBreaker':
					if (isBoolean(value)) {
						data[formattedField] = value;
					}
					break;
				default:
					break;
			}
		}

		if (isEmpty(data)) {
			return reject(new Error('No updatable fields given'));
		}

		data.code = code;

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	async uploadIcon(image, name, opts = {
		additionalHeaders: null
	}) {
		if (!isBuffer(image)) {
			return reject(parameterError('image', 'must be a buffer'));
		} else if (!isString(name)) {
			return reject(parameterError('name', 'cannot be null'));
		}

		const { ext, mime } = await FileType.fromBuffer(image);

		if (mime.indexOf('image/') !== 0) {
			return reject(parameterError('image', 'must be an image'));
		}

		const verb = 'POST';
                const path = `/icon`;

		const formData = {
			file: {
				value: image,
				options: {
					filename: `${name}.${ext}`,
					contentType: mime
				}
			},
			file_name: name
		};

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders)
				? { ...this.headers, ...opts.additionalHeaders, 'content-type': 'multipart/form-data' }
				: { ...this.headers, 'content-type': 'multipart/form-data' },
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			omit(formData, [ 'file' ])
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { formData });
	}

async generateDashToken() {
    return generateDashTokenUtils({
        user_id: this.user_id,
        email: this.email,
        role: this.role || 'admin'
    });
}

	/**
	 * Get a broker quote from network
	 * @param {number} userId; - Optional Network id of user.
	 * @param {string} spendingCurrency - Currency user wants to convert from.
	 * @param {number} spendingAmount - Optional Amount user wants to spend.
	 * @param {string} receivingCurrency - Currency user wants to convert to.
	 * @param {number} receivingAmount - Optional Amount user wants to receive.
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object with quote data.
	 */
	getQuote(userId, spendingCurrency, spendingAmount, receivingCurrency, receivingAmount, opts = {
		additionalHeaders: null
	}) {
		if (!spendingCurrency) {
			return reject(parameterError('spendingCurrency', 'cannot be null'));
		} else if (!receivingCurrency) {
			return reject(parameterError('receivingCurrency', 'cannot be null'));
		}

		const verb = 'GET';
                let path = `/broker/quote?`;
		if (isNumber(userId)) {
			path += `&user_id=${userId}`;
		}
		if (isString(spendingCurrency)) {
			path += `&spending_currency=${spendingCurrency}`;
		}
		if (isNumber(spendingAmount)) {
			path += `&spending_amount=${spendingAmount}`;
		}
		if (isString(receivingCurrency)) {
			path += `&receiving_currency=${receivingCurrency}`;
		}
		if (isNumber(receivingAmount)) {
			path += `&receiving_amount=${receivingAmount}`;
		}

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers);
	}

	/**
	 * Execute the broker quote to network for a user
	 * @param {string} token; - Broker quote token.
	 * @param {number} user_id - User ID to execute the trade
	 * @param {number} fee - Fee in percentage to apply to the trade
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object of the trade data.
	 */
	executeQuote(token, user_id, fee, opts = {
		additionalHeaders: null
	}) {
		if (!token) {
			return reject(parameterError('token', 'cannot be null'));
		}

		const verb = 'POST';
                const path = `/broker/execute`;

		const data = {
			token,
			user_id,
			fee
		};

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Locks users available balance
	 * @param {number} user_id - User ID to lock the balance
	 * @param {string} currency - Currency that should be locked
	 * @param {number} amount - The amount to lock in the balance
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object of the success message.
	 */
	lockBalance(user_id, currency, amount, opts = {
		additionalHeaders: null
	}) {
		if (!user_id) {
			return reject(parameterError('user_id', 'cannot be null'));
		}
		if (!currency) {
			return reject(parameterError('currency', 'cannot be null'));
		}
		if (!amount) {
			return reject(parameterError('amount', 'cannot be null'));
		}

		const verb = 'POST';
                const path = `/balance/lock`;

		const data = {
			user_id,
			currency,
			amount
		};

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);

		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Unlocks users available balance
	 * @param {number} user_id - User ID to unlock the balance
	 * @param {number} lock_id - The lock ID to unlock
	 * @param {object} opts - Optional parameters.
	 * @param {object} opts.additionalHeaders - Object storing addtional headers to send with request.
	 * @return {object} Object of the success message.
	 */
	unlockBalance(user_id, lock_id, opts = {
		additionalHeaders: null
	}) {
		if (!user_id) {
			return reject(parameterError('user_id', 'cannot be null'));
		}
		if (!lock_id) {
			return reject(parameterError('lock_id', 'cannot be null'));
		}

		const verb = 'POST';
                const path = `/balance/unlock`;

		const data = {
			user_id,
			lock_id
		};

		const headers = generateHeaders(
			isPlainObject(opts.additionalHeaders) ? { ...this.headers, ...opts.additionalHeaders } : this.headers,
			this.apiSecret,
			verb,
			path,
			this.apiExpiresAfter,
			data
		);
		return createRequest(verb, `${this.apiUrl}${path}`, headers, { data });
	}

	/**
	 * Connect to websocket
	 * @param {array} events - Array of events to connect to
	 */
        connect(events = []) {
/*
                this.wsUrl = `wss://forkex.life/stream?exchange_id=${this.exchange_id}&activation_code=${this.activation_code}`
                //this.wsUrl = 'ws://hollaex-kit-server-api:10011/stream'
                this.wsReconnect = true;
                this.wsEvents = events;
                const apiExpires = moment().unix() + this.apiExpiresAfter;
                const signature = createSignature(
                        this.apiSecret,
                        'CONNECT',
                        '/stream',
                        apiExpires
                );
                this.ws = new WebSocket(this.wsUrl, {
                        headers: {
                                'api-key': this.apiKey,
                                'api-signature': signature,
                                'api-expires': apiExpires,
                                'api-activation-code': this.activation_code
                        }
                });
*/
    // ВАЖНО: Не подключайтесь к внешнему URL если вы сами WebSocket сервер
    // Проверяем, не пытаемся ли мы подключиться к самим себе
    const isSelfConnection = this.wsUrl && 
        (this.wsUrl.includes('forkex.life') || 
         this.wsUrl.includes('localhost:10011') ||
         this.wsUrl.includes('hollaex-kit-server-stream'));
    
    if (isSelfConnection) {
        loggerWebsocket.warn('Preventing self-connection loop for WebSocket');
        
        // Создаем заглушку вместо реального подключения
        this.ws = {
            readyState: 1, // OPEN
            on: (event, callback) => {
                if (event === 'open') {
                    setTimeout(callback, 100);
                }
            },
            send: (data) => {
                loggerWebsocket.verbose('Mock WebSocket send:', data);
            },
            close: () => {
                loggerWebsocket.info('Mock WebSocket closed');
            }
        };
        
        // Эмулируем успешное подключение
        setTimeout(() => {
            if (typeof this.onConnect === 'function') {
                this.onConnect();
            }
        }, 500);
        
        return;
    }
    
    // Оригинальный код для реальных внешних подключений
    this.wsUrl = `wss://api.hollaex.com/stream?exchange_id=${this.exchange_id}&activation_code=${this.activation_code}`;
    this.wsReconnect = true;
    this.wsEvents = events;
    
    const apiExpires = moment().unix() + this.apiExpiresAfter;
    const signature = createSignature(
        this.apiSecret,
        'CONNECT',
        '/stream',
        apiExpires
    );
    
    this.ws = new WebSocket(this.wsUrl, {
        headers: {
            'api-key': this.apiKey,
            'api-signature': signature,
            'api-expires': apiExpires,
            'api-activation-code': this.activation_code
        }
    });

                if (this.wsEventListeners) {
                        loggerWebsocket.info('yes.[WS DEBUG] wsEventListeners =', this.wsEventListeners);
                        this.ws._events = this.wsEventListeners;
                } else {
                        loggerWebsocket.info('not.[WS DEBUG] wsEventListeners =', this.wsEventListeners, this.ws.on);
                        this.ws.on('unexpected-response', () => {
                                if (this.ws.readyState !== WebSocket.CLOSING) {
                                        if (this.ws.readyState === WebSocket.OPEN) {
                                                this.ws.close();
                                        } else if (this.wsReconnect) {
                                                this.wsEventListeners = this.ws._events;
                                                this.ws = null;
                                                setTimeout(() => {
                                                        this.connect(this.wsEvents);
                                                }, this.wsReconnectInterval);
                                        } else {
                                                this.wsEventListeners = null;
                                                this.ws = null;
                                        }
                                }
                        });

                        this.ws.on('error', () => {
                                if (this.ws.readyState !== WebSocket.CLOSING) {
                                        if (this.ws.readyState === WebSocket.OPEN) {
                                                this.ws.close();
                                        } else if (this.wsReconnect) {
                                                this.wsEventListeners = this.ws._events;
                                                this.ws = null;
                                                setTimeout(() => {
                                                        this.connect(this.wsEvents);
                                                }, this.wsReconnectInterval);
                                        } else {
                                                this.wsEventListeners = null;
                                                this.ws = null;
                                        }
                                }
                        });

                        this.ws.on('close', () => {
                                if (this.wsReconnect) {
                                        this.wsEventListeners = this.ws._events;
                                        this.ws = null;
                                        setTimeout(() => {
                                                this.connect(this.wsEvents);
                                        }, this.wsReconnectInterval);
                                } else {
                                        this.wsEventListeners = null;
                                        this.ws = null;
                                }
                        });

                        this.ws.on('open', () => {
                                if (this.wsEvents.length > 0) {
                                        this.subscribe(this.wsEvents);
                                }

                                setWsHeartbeat(this.ws, 'ping', {
                                        pingTimeout: 60000,
                                        pingInterval: 25000
                                });
                        });
                }
        }

	/**
	 * Disconnect from Network websocket
	 */
	disconnect() {
		if (this.wsConnected()) {
			this.wsReconnect = false;
			this.ws.close();
		} else {
			throw new Error('Websocket not connected');
		}
	}

	/**
	 * Subscribe to Network websocket events
	 * @param {array} events - The events to listen to
	 */
	subscribe(events = []) {
		if (this.wsConnected()) {
			this.ws.send(
				JSON.stringify({
					op: 'subscribe',
					args: events
				})
			);
		} else {
			throw new Error('Websocket not connected');
		}
	}

	/**
	 * Unsubscribe to Network websocket events
	 * @param {array} events - The events to unsub from
	 */
	unsubscribe(events = []) {
		if (this.wsConnected()) {
			this.ws.send(
				JSON.stringify({
					op: 'unsubscribe',
					args: events
				})
			);
		} else {
			throw new Error('Websocket not connected');
		}
	}
}

module.exports = HollaExNetwork;
;
