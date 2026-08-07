'use strict';

const Redis = require('ioredis');

function createRedisClient({ host, port, password, role }) {
    const client = new Redis({
        host,
        port: Number(port),
        password,
        lazyConnect: false,
        enableReadyCheck: true,
        maxRetriesPerRequest: null
    });

    client.on('connect', () => {
        console.log(`[REDIS][${role}] connected → ${host}:${port}`);
    });

    client.on('error', (err) => {
        console.error(`[REDIS][${role}] error:`, err.message);
    });

    return client;
}

/**
 * Основной Redis (commands + publish)
 */
const redis = createRedisClient({
    role: 'MAIN',
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
});

/**
 * Redis для Pub/Sub (subscribe)
 */
const redisSub = createRedisClient({
    role: 'SUB',
    host: process.env.PUBSUB_HOST || process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.PUBSUB_PORT || process.env.REDIS_PORT || 6379,
    password: process.env.PUBSUB_PASSWORD || process.env.REDIS_PASSWORD
});

module.exports = {
    redis,
    redisSub
};
