'use strict';

const redis = require('redis');
const config = require('../config/redis');
const { loggerRedis } = require('../config/logger');

const isV6 = !redis.Multi;

let client;

if (isV6) {
	const { host, port, password } = config.client;
	const url = `redis://${host || '127.0.0.1'}:${port || 6379}`;
	const opts = { url };
	if (password) opts.password = password;
	client = redis.createClient(opts);

	client.on('ready', () => {
		if (loggerRedis) loggerRedis.info('Redis is ready');
	});

	client.on('error', (err) => {
		if (loggerRedis) loggerRedis.error('REDIS', err.message);
		if (loggerRedis) loggerRedis.error(err);
		process.exit(0);
	});

	client.connect().catch((err) => {
		if (loggerRedis) loggerRedis.error('Redis connect error:', err.message);
		process.exit(0);
	});
} else {
	const { promisifyAll } = require('bluebird');
	promisifyAll(redis.RedisClient.prototype);
	promisifyAll(redis.Multi.prototype);

	client = redis.createClient(config.client);

	client.on('ready', () => {
		if (loggerRedis) loggerRedis.info('Redis is ready');
	});

	client.on('connect', () => {
		if (loggerRedis) loggerRedis.verbose('Connect to redis');
		if (config.client.password) {
			client.auth(config.client.password, () => {
				if (loggerRedis) loggerRedis.verbose('Authenticated to redis');
			});
		}
	});

	client.on('error', (err) => {
		if (loggerRedis) loggerRedis.error('REDIS', err.message);
		if (loggerRedis) loggerRedis.error(err);
		process.exit(0);
	});
}

module.exports = client;
