const rp = require('request-promise');
const crypto = require('crypto');
const moment = require('moment');
const { isDate } = require('lodash');
const requestCache = new Map();
const cachePeriods = {
	// 'chart': 40,
	'charts': 30,
	'oracle': 30,
	'minichart': 60 // 5 minute
};

// Функция для получения токена из заголовков запроса (например, Authorization)

const createRequest = (verb, url, headers, opts = {}, cachePeriod = 0) => {
//const createRequest = (verb, url, headers,   opts = { data: null, formData: null }, cachePeriod = 0, baseUrl = null) => {

  const key = `${verb}:${url}`;
  if (cachePeriod > 0 && cache.has(key) && Date.now() - cache.get(key).ts < cachePeriod) {
    return Promise.resolve(cache.get(key).body);
  }
console.log('=== url: ',url);
  const reqOpts = { method: verb, uri: url, headers, json: true, timeout: 5000 };

  if (opts.data)     reqOpts.body = opts.data;
  if (opts.formData) reqOpts.formData = opts.formData;

  return rp(reqOpts)
    .then(body => {
      if (cachePeriod > 0 && verb === 'GET') {
        cache.set(key, { ts: Date.now(), body });
      }
      return body;
    });
};

const _createRequest = (verb, url, headers, opts = { data: null, formData: null }, baseUrl = null) => {
	const requestObj = {
		headers,
		url,
		json: true,
                timeout: 5000
	};
	if (opts.data) {
		requestObj.body = opts.data;
	}
	if (opts.formData) {
		requestObj.formData = opts.formData;
	}
	const urlKey = `${verb}-${url}`;
	let fetchRequest = null;
console.log('=== requestObj: ', 'requestObj');
console.log('=== requestCache: ', 'requestCache');
	if (requestCache.has(urlKey) 
		&& new Date().getTime() - new Date(requestCache.get(urlKey).timestamp).getTime() < requestCache.get(urlKey).period * 1000) {
		fetchRequest = requestCache.get(urlKey).request;
console.log('===1 return: ', 'fetchRequest');
	}
	else {
		fetchRequest = rp[verb.toLowerCase()](requestObj);
console.log('===2 return: ', 'fetchRequest');
		if(verb === 'GET' && !url.includes('user_id')){
			requestCache.set(urlKey, {
				timestamp: new Date(),
				request: fetchRequest,
				period: cachePeriods[baseUrl] || 5
			});
		}
console.log('===3 return: ', 'fetchRequest');
	}
console.log('===4 return: ', 'fetchRequest');
	return fetchRequest;
};

const createSignature = (secret = '', verb, path, expires, data = '') => {
	const stringData = typeof data === 'string' ? data : JSON.stringify(data);
	const signature = crypto
		.createHmac('sha256', secret)
		.update(verb + path + expires + stringData)
		.digest('hex');
	return signature;
};

const generateHeaders = (headers, secret, verb, path, expiresAfter, data) => {
	const expires = moment().unix() + expiresAfter;
        //const expires = Math.floor(Date.now() / 1000) + 60; // 60 секунд в будущее
	const signature = createSignature(secret, verb, path, expires, data);
	const header = {
		...headers,
		'api-signature': signature,
		'api-expires': expires
	};
	return header;
};

const checkKit = (kit) => {
	if (!kit) {
		throw new Error(
			'Missing Kit ID. ID of the exchange Kit should be initialized in HollaEx constructor'
		);
	}
	return true;
};

const parameterError = (parameter, msg) => {
	return new Error(`Parameter ${parameter} error: ${msg}`);
};

const isDatetime = (date, formats = [ moment.ISO_8601 ]) => {
	return moment(date, formats, true).isValid();
};

const sanitizeDate = (date) => {
	let result = date;
	if (isDate(result)) {
		result = moment(result).toISOString();
	}

	return result;
};

const isUrl = (url) => {
	const pattern = /^(^|\s)((http(s)?:\/\/)?[\w-]+(\.[\w-]+)+\.?(:\d+)?(\/\S*)?)$/;
	return pattern.test(url);
};

module.exports = {
	createRequest,
	createSignature,
	generateHeaders,
	checkKit,
	parameterError,
	isDatetime,
	sanitizeDate,
	isUrl
};
