// Файл: /opt/forkex/server/api/services/charts.js
'use strict';

const fetch = require('node-fetch');

/**
 * Получение данных графика из внешнего API
 */
async function getChartFromExternalAPI(asset, quote, period, from, to) {
    try {
        const symbol = `${asset}-${quote}`.toUpperCase();
        const isKaspa = symbol === 'KAS-USDT';
        
        if (isKaspa) {
            return await getKaspaChartData(from, to, period);
        }
        
        // Используем Hollaex API (как в большой графике)
        const resolution = convertPeriodToResolution(period);
        const fromTime = from || Math.floor(Date.now() / 1000) - 86400; // 24 часа назад
        const toTime = to || Math.floor(Date.now() / 1000);
        
        const url = `https://api.hollaex.com/v2/chart?symbol=${symbol.toLowerCase()}&resolution=${resolution}&from=${fromTime}&to=${toTime}`;
        
        console.log(`Fetching chart from: ${url}`);
        
        const response = await fetch(url, {
            timeout: 10000 // 10 секунд timeout
        });
        
        if (!response.ok) {
            console.warn(`Hollaex API returned ${response.status} for ${symbol}`);
            return [];
        }
        
        const chartData = await response.json();
        
        if (Array.isArray(chartData)) {
            return chartData.map(item => ({
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
        console.error(`Error fetching external chart for ${asset}:`, error.message);
        return [];
    }
}

/**
 * Получение данных KAS из CoinGecko
 */
async function getKaspaChartData(from, to, period) {
    try {
        const fromTime = from || Math.floor(Date.now() / 1000) - 86400;
        const toTime = to || Math.floor(Date.now() / 1000);

        const url = `https://api.coingecko.com/api/v3/coins/kaspa/market_chart/range?vs_currency=usd&from=${fromTime}&to=${toTime}`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'ForkEX-chart-proxy/1.0 (exchange chart proxy)'
            },
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`CoinGecko API error: ${response.status}`);
        }

        const json = await response.json();
        const prices = json.prices || [];
        const volumeMap = new Map((json.total_volumes || []).map((v) => [v[0], v[1]]));

        return prices.map((item) => ({
            time: Math.floor(item[0] / 1000),
            open: item[1],
            high: item[1],
            low: item[1],
            close: item[1],
            volume: volumeMap.get(item[0]) || 0
        }));

    } catch (error) {
        console.error('Error fetching KAS chart:', error.message);
        return [];
    }
}

/**
 * Генерация mock данных графика
 */
function generateMockChartData(asset, from, to, period = '1h') {
    const data = [];
    const now = to || Math.floor(Date.now() / 1000);
    const start = from || now - 86400; // 24 часа по умолчанию
    
    let price = getBasePrice(asset);
    const timeStep = getTimeStep(period);
    const volatility = getVolatility(asset);
    
    // Генерируем реалистичные данные с трендом
    const trend = (Math.random() - 0.5) * 0.1; // Случайный тренд ±5%
    
    for (let time = start; time <= now; time += timeStep) {
        // Добавляем тренд + случайные колебания
        const randomChange = (Math.random() - 0.5) * volatility;
        const trendChange = trend * (time - start) / (now - start);
        price = price * (1 + randomChange + trendChange);
        
        // Ограничиваем цену разумными пределами
        price = Math.max(price, getBasePrice(asset) * 0.5);
        price = Math.min(price, getBasePrice(asset) * 2);
        
        data.push({
            time,
            open: price * (1 - Math.random() * 0.01),
            high: price * (1 + Math.random() * 0.02),
            low: price * (1 - Math.random() * 0.02),
            close: price,
            volume: 1000 + Math.random() * 5000
        });
    }
    
    return data;
}

/**
 * Конвертация периода в разрешение для API
 */
function convertPeriodToResolution(period) {
    const map = {
        '1h': '1h',
        '1d': '1D',
        '1w': '1W',
        '1M': '1M',
        '7d': '1W',
        '30d': '1M'
    };
    return map[period] || '1h';
}

/**
 * Получение базовой цены для актива
 */
function getBasePrice(asset) {
    const prices = {
        'BTC': 45000,
        'ETH': 2500,
        'KAS': 0.10,
        'LBTC': 0.01,
        'USDT': 1.00,
        'BNB': 300,
        'XRP': 0.60,
        'ADA': 0.45,
        'SOL': 100,
        'DOGE': 0.15,
        'DOT': 7,
        'GOR': 0.03,
        'default': 100
    };
    return prices[asset.toUpperCase()] || prices.default;
}

/**
 * Получение волатильности для актива
 */
function getVolatility(asset) {
    const volatilities = {
        'BTC': 0.03,
        'ETH': 0.04,
        'KAS': 0.08,
        'DOGE': 0.10,
        'default': 0.05
    };
    return volatilities[asset.toUpperCase()] || volatilities.default;
}

/**
 * Получение временного шага для периода
 */
function getTimeStep(period) {
    const steps = {
        '1h': 3600,      // 1 час
        '1d': 86400,     // 1 день
        '1w': 604800,    // 1 неделя
        '7d': 604800,    // 7 дней
        '1M': 2592000,   // 30 дней
        '30d': 2592000,  // 30 дней
        'default': 3600
    };
    return steps[period] || steps.default;
}

module.exports = {
    getChartFromExternalAPI,
    getKaspaChartData,
    generateMockChartData,
    convertPeriodToResolution,
    getBasePrice,
    getVolatility,
    getTimeStep
};
