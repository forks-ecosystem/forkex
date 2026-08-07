'use strict';
const redis = require('redis');
const config = require('../config/redis');
const { loggerRedis } = require('../config/logger');

function authClient(client) {
	client.on('connect', () => {
		if (loggerRedis) loggerRedis.verbose('Connect to PubSub');
		if (config.pubsub.password) {
			client.auth(config.pubsub.password, () => {
				if (loggerRedis) loggerRedis.verbose('Authenticated to PubSub');
			});
		}
	});
	client.on('ready', () => {
		if (loggerRedis) loggerRedis.info('PubSub is ready');
	});
	client.on('error', (err) => {
		if (loggerRedis) loggerRedis.error('PUBSUBS', err.message);
		if (loggerRedis) loggerRedis.error(err);
		process.exit(0);
	});
}

const publisher = redis.createClient(config.pubsub);
const subscriber = redis.createClient(config.pubsub);

authClient(publisher);
authClient(subscriber);

module.exports = {
	publisher,
	subscriber
};