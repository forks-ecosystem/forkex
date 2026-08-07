'use strict';

const packageJson = require('../../package.json');
const { API_HOST, HOLLAEX_NETWORK_ENDPOINT, DOMAIN } = require('../../constants');
const { loggerPublic } = require('../../config/logger');
const toolsLib = require('hollaex-tools-lib');
const { errorMessageConverter } = require('../../utils/conversion');
const { getAuthToken } = require('../../utils/strings');
const { getCoinsFromDB } = require('../services/coins');
const { getPairsFromDB } = require('../services/pairs');
const { 
    getChartFromExternalAPI, 
    generateMockChartData,
    getKaspaChartData 
} = require('../services/charts');

const getPairs = async (req, res) => {
    try {
        const coins = await getPairsFromDB();
        res.json(coins);
    } catch (err) {
        console.error('getPairs error:', err);
        res.status(500).json({ message: 'Failed to load pairs' });
    }
};

const getCoins = async (req, res) => {
    try {
        const coins = await getCoinsFromDB();
        res.json(coins);
    } catch (err) {
        console.error('getCoins error:', err);
        res.status(500).json({ message: 'Failed to load coins' });
    }
};

const getHealth = (req, res) => {
	try {
		return res.json({
			name: toolsLib.getKitConfig().api_name || packageJson.name,
			version: packageJson.version,
			host: API_HOST,
			domain: DOMAIN,
			basePath: '/v2',
			status: toolsLib.getKitConfig().status
		});
	} catch (err) {
		loggerPublic.verbose('controller/public/getHealth', err.message);
		const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
		return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
	}
};

const getConstants = (req, res) => {
	try {
		return res.json({
			coins: toolsLib.getKitCoinsConfig(),
			pairs: toolsLib.getKitPairsConfig(),
			broker: toolsLib.getBrokerDeals(),
			quicktrade: toolsLib.getQuickTrades(),
			transactionLimits: toolsLib.getTransactionLimits(),
			networkQuickTrades: toolsLib.getNetworkQuickTrades(),
			network: HOLLAEX_NETWORK_ENDPOINT
		});
	} catch (err) {
		loggerPublic.verbose('controller/public/getConstants', err.message);
		const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
		return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
	}
};

const getNetworkConstants = (req, res) => {
	toolsLib.getNetworkConstants({
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.verbose('controller/public/getNetworkConstants', err.message);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getKitConfigurations = (req, res) => {
	try {
		return res.json(toolsLib.getKitConfig());
	} catch (err) {
		loggerPublic.verbose('controller/public/getKitConfigurations', err.message);
		const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
		return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
	}
};

const sendSupportEmail = (req, res) => {
	const { email, category, subject, description }  = req.swagger.params;
	toolsLib.sendEmailToSupport(email.value, category.value, subject.value, description.value)
		.then(() => {
			return res.json({ message: 'Email was sent to support' });
		})
		.catch((err) => {
			loggerPublic.verbose('controller/public/sendSupportEmail', err.message);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getTopOrderbook = (req, res) => {
	const symbol = req.swagger.params.symbol.value;

	toolsLib.getOrderbook(symbol, {
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getTopOrderbook',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getTopOrderbooks = (req, res) => {
	toolsLib.getOrderbooks({
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getTopOrderbooks',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getTrades = (req, res) => {
	const symbol = req.swagger.params.symbol.value;

	if (symbol && !toolsLib.subscribedToPair(symbol)) {
		loggerPublic.error(
			req.uuid,
			'controller/public/getTopOrderbooks',
			'Invalid symbol'
		);
		return res.status(400).json({ message: 'Invalid symbol' });
	}

	toolsLib.getPublicTrades(symbol, {
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getTrades',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getTradesHistory = (req, res) => {
	const { symbol, side, limit, page, order_by, order, start_date, end_date } = req.swagger.params;

	if (symbol.value && !toolsLib.subscribedToPair(symbol.value)) {
		loggerPublic.error(
			req.uuid,
			'controller/public/getTopOrderbooks',
			'Invalid symbol'
		);
		return res.status(400).json({ message: 'Invalid symbol' });
	}

	toolsLib.getTradesHistory(
		symbol.value,
		side.value,
		limit.value,
		page.value,
		order_by.value,
		order.value,
		start_date.value,
		end_date.value,
		{
			additionalHeaders: {
				'x-forwarded-for': req.headers['x-forwarded-for']
			}
		}
	)
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getTrades',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getTicker = async (req, res) => {
	const symbol = req.swagger.params.symbol?.value;
	try {
		const data = await toolsLib.getTicker(symbol, {
			additionalHeaders: { 'x-forwarded-for': req.headers['x-forwarded-for'] }
		});
		return res.json(data);
	} catch (err) {
		loggerPublic.error(req.uuid, 'controller/public/getTicker (fallback)', err.message);
		try {
			const { getTickersUtils } = require('../../utils/getTickersUtils');
			const allTickers = await getTickersUtils();
			if (symbol && allTickers[symbol]) {
				return res.json(allTickers[symbol]);
			}
			return res.json({});
		} catch (e2) {
			return res.json({});
		}
	}
};

const getAllTicker = async (req, res) => {
	try {
		const data = await toolsLib.getTickers({
			additionalHeaders: { 'x-forwarded-for': req.headers['x-forwarded-for'] }
		});
		return res.json(data);
	} catch (err) {
		loggerPublic.error(req.uuid, 'controller/public/getAllTicker (fallback)', err.message);
		try {
			const { getTickersUtils } = require('../../utils/getTickersUtils');
			const data = await getTickersUtils();
			return res.json(data);
		} catch (e2) {
			return res.json({});
		}
	}
};

const getChart = (req, res) => {
	const { from, to, symbol, resolution } = req.swagger.params;

	if (!toolsLib.subscribedToPair(symbol.value)) {
		loggerPublic.error(
			req.uuid,
			'controller/public/getChart',
			'Invalid symbol'
		);
		return res.status(400).json({ message: 'Invalid symbol' });
	}

	toolsLib.getChart(from.value, to.value, symbol.value, resolution.value, {
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getChart',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getCharts = (req, res) => {
	const { from, to, resolution } = req.swagger.params;

	toolsLib.getCharts(from.value, to.value, resolution.value, {
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getCharts',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};
/**
 * Получение мини-графиков для нескольких активов
 * GET /minicharts
 */
const getMiniCharts = async (req, res) => {
    try {
        const { 
            assets, 
            from, 
            to, 
            quote = { value: 'usdt' },
            period = { value: '1h' }
        } = req.swagger.params;
        
        // Извлекаем значения (Swagger передает их как объекты)
        const assetsValue = assets.value;
        const fromValue = from ? from.value : null;
        const toValue = to ? to.value : null;
        const quoteValue = quote.value;
        const periodValue = period.value;
        
        // Обрабатываем assets (может быть строкой или массивом)
        let assetsArray;
        if (Array.isArray(assetsValue)) {
            assetsArray = assetsValue;
        } else if (typeof assetsValue === 'string') {
            assetsArray = assetsValue.split(',').map(a => a.trim().toUpperCase());
        } else {
            return res.status(400).json({
                success: false,
                message: 'Assets must be a comma-separated string or array'
            });
        }
        
        // Проверяем, что есть хотя бы один актив
        if (assetsArray.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No assets provided'
            });
        }
        
        const result = {};
        
        // Обрабатываем каждый ассет параллельно
        await Promise.all(assetsArray.map(async (asset) => {
            try {
                // 1. Пробуем получить данные из внешнего API
                let chartData = await getChartFromExternalAPI(
                    asset, 
                    quoteValue, 
                    periodValue, 
                    fromValue, 
                    toValue
                );
                
                // Для мини-графика берем последние 24 точки
                result[asset.toLowerCase()] = chartData.length > 0 ? chartData.slice(-24) : [];
                
            } catch (error) {
                console.error(`Error processing ${asset}:`, error);
                result[asset.toLowerCase()] = [];
            }
        }));
        
        return res.json(result);
        
    } catch (error) {
        console.error('getMiniCharts error:', error);
        
        loggerPublic.error(
            req.uuid,
            'controller/public/getMiniCharts',
            error.message
        );
        
        const messageObj = errorMessageConverter(error, req?.auth?.sub?.lang);
        return res.status(error.statusCode || 500).json({ 
            success: false,
            message: messageObj?.message || 'Failed to fetch mini charts',
            lang: messageObj?.lang, 
            code: messageObj?.code 
        });
    }
};

// поменяли на новый обработчик
const __getMiniCharts = (req, res) => {
	const { assets, from, to, quote, period } = req.swagger.params;
	toolsLib.getMiniCharts(assets.value, { from: from.value, to: to.value, quote: quote.value, period: period.value, additionalHeaders: {
		'x-forwarded-for': req.headers['x-forwarded-for']
	}})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getMiniCharts',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getConfig = (req, res) => {
	toolsLib.getUdfConfig({
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getConfig',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getHistory = (req, res) => {
	const { symbol, from, to, resolution } = req.swagger.params;

	if (!toolsLib.subscribedToPair(symbol.value)) {
		loggerPublic.error(
			req.uuid,
			'controller/public/getHistory',
			'Invalid symbol'
		);
		return res.status(400).json({ message: 'Invalid symbol' });
	}

	toolsLib.getUdfHistory(from.value, to.value, symbol.value, resolution.value, {
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getHistory',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

const getSymbols = (req, res) => {
	const symbol = req.swagger.params.symbol.value;

	if (!toolsLib.subscribedToPair(symbol)) {
		loggerPublic.error(
			req.uuid,
			'controller/public/getSymbols',
			'Invalid symbol'
		);
		return res.status(400).json({ message: 'Invalid symbol' });
	}

	toolsLib.getUdfSymbols(symbol, {
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getSymbols',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};
const _getAssetsPrices = (req, res) => {
        let { assets, quote, amount } = req.swagger.params;
        //const bearerToken = getAuthToken(req);
        //if (!quote || quote === 'undefined') {
          quote = 'usdt';
        //}
        const authHeader = req.headers['authorization'];  // Получаем заголовок Authorization
        if (!authHeader) {
            return null;  // Если заголовка нет, возвращаем null
        }

        // Проверяем, что заголовок начинается с "Bearer "
        const bearerToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)  // Убираем "Bearer " и оставляем только токен
        : null;

        loggerPublic.info('==!1!== assets', assets.value, 'quote', quote.value, 'amount', amount.value);

        if (!bearerToken) {
            return reject(parameterError('Authorization', 'Token is required'));  // Возвращаем ошибку, если токен отсутствует
        }
        loggerPublic.info('==!2!== assets', assets.value, 'quote', quote.value, 'amount', amount.value);

        // --- CRITICAL FIX ---
        if (!quote || quote === 'undefined') {
          quote = 'usdt';
        }
        amount = Number(amount) || 1;
        if (!assets) {
          return res.status(400).json({ message: 'assets is required' });
        }
        if (typeof assets === 'string') {
          assets = assets.split(',');
        }
        if(quote.value && typeof quote.value !== 'string'){
                loggerPublic.error(
                        req.uuid,
                        'controllers/public/getAssetsPrices invalid quote',
                        quote.value
                );
                return res.status(400).json({ message: 'Invalid quote' });
        }
        loggerPublic.info('======ALL===controllers/public/getAssetsPrices assets', assets.value, 'quote', quote, 'amount', amount);
        toolsLib.getAssetsPrices(assets.value, 'usdt', 1, {
                additionalHeaders: {
                        'x-forwarded-for': req.headers['x-forwarded-for'],
                        'bearerToken': bearerToken
                }
        })
                .then((data) => {
                        return res.json(data);
                })
                .catch((err) => {
                        loggerPublic.error(
                                req.uuid,
                                'controller/public/getAssetsPrices',
                                err.message
                        );
                        return res.status(err.statusCode || 400).json({ message: errorMessageConverter(err, req?.auth?.sub?.lang) });
                });
};
const getAssetsPrices = (req, res) => {
    let { assets, quote, amount } = req.swagger.params;

    assets = assets?.value;
    quote  = quote?.value;
    amount = Number(amount?.value) || 1;

    // ✅ CANONICAL DEFAULTS
    if (!quote || quote === 'undefined') {
        quote = 'usdt';
    }

    if (!assets) {
        return res.status(400).json({ message: 'assets is required' });
    }

    if (typeof assets === 'string') {
        assets = assets.split(',');
    }

    loggerPublic.info(
        req.uuid,
        'controllers/public/getAssetsPrices',
        'assets', assets,
        'quote', quote,
        'amount', amount
    );

    toolsLib.getAssetsPrices(assets, quote, amount, {
        additionalHeaders: {
            'x-forwarded-for': req.headers['x-forwarded-for']
        }
    })
    .then((data) => res.json(data))
    .catch((err) => {
        loggerPublic.error(req.uuid, 'controller/public/getAssetsPrices', err.message);
        const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
        return res
            .status(err.statusCode || 400)
            .json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
    });
};

const _2getAssetsPrices = (req, res) => {
	const { assets, quote, amount } = req.swagger.params;
        loggerPublic.info('==!1!== assets', assets.value, 'quote', quote.value, 'amount', amount.value);
        // --- CRITICAL FIX ---
        //if (!quote || quote === 'undefined') {
        //  quote = 'usdt';
        //}
        /*
        amount = Number(amount) || 1;
        if (!assets) {
          return res.status(400).json({ message: 'assets is required' });
        }
        if (typeof assets === 'string') {
          assets = assets.split(',');
        }
        */
        loggerPublic.info('==!2!== assets', assets.value, 'quote', quote.value, 'amount', amount.value);
	if(quote.value && typeof quote.value !== 'string'){
		loggerPublic.error(
			req.uuid,
			'3. controllers/public/getAssetsPrices invalid quote',
			quote.value
		);
		return res.status(400).json({ message: 'Invalid quote' });
	}

	loggerPublic.info(req.uuid, 'controllers/public/getAssetsPrices assets', assets.value, 'quote', quote.value, 'amount', amount.value);

	toolsLib.getAssetsPrices(assets.value, quote.value, amount.value, {
		additionalHeaders: {
			'x-forwarded-for': req.headers['x-forwarded-for']
		}
	})
		.then((data) => {
			return res.json(data);
		})
		.catch((err) => {
			loggerPublic.error(
				req.uuid,
				'controller/public/getAssetsPrices',
				err.message
			);
			const messageObj = errorMessageConverter(err, req?.auth?.sub?.lang);
			return res.status(err.statusCode || 400).json({ message: messageObj?.message, lang: messageObj?.lang, code: messageObj?.code });
		});
};

module.exports = {
	getPairs,
	getCoins,
	getHealth,
	getConstants,
	getKitConfigurations,
	sendSupportEmail,
	getTopOrderbook,
	getTopOrderbooks,
	getTrades,
	getTicker,
	getAllTicker,
	getChart,
	getCharts,
	getMiniCharts,
        __getMiniCharts, // Старая функция (можно удалить позже)
	getConfig,
	getHistory,
	getSymbols,
	getAssetsPrices,
	getTradesHistory,
	getNetworkConstants
};
