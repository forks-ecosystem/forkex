'use strict';

const wss = require('./server');
const uuid = require('uuid/v4');
const { loggerWebsocket } = require('../config/logger');
const {
	WS_EMPTY_MESSAGE,
	WS_WRONG_INPUT,
	WS_WELCOME,
	WS_UNSUPPORTED_OPERATION,
	WS_USER_AUTHENTICATED
} = require('../messages');
const { initializeTopic, terminateTopic, authorizeUser, terminateClosedChannels, handleChatData, handleP2pData } = require('./sub');
const { connect, hubConnected } = require('./hub');
const { setWsHeartbeat } = require('ws-heartbeat/server');
const WebSocket = require('ws');

const clientMessageCounts = new Map();
const MAX_MESSAGES_PER_SECOND = 10;

wss.on('connection', async (ws, req) => {
	ws.id = uuid();
	loggerWebsocket.info('ws/connection', ws.id, req.url);

	const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
	const url = new URL(req.url, 'http://localhost');
	const bearerToken = url.searchParams.get('authorization');
	const hmacKey = url.searchParams.get('api-key');

	if (bearerToken) {
		try {
			const token = bearerToken.replace('Bearer ', '');
			const auth = await require('hollaex-tools-lib').security.verifyBearerTokenPromise(token, ip);
			ws.auth = auth;
			ws.send(JSON.stringify({ message: WS_USER_AUTHENTICATED(ws.auth.sub.email) }));
		} catch (err) {
			loggerWebsocket.verbose('ws/connection auth failed', err.message);
		}
	} else if (hmacKey) {
		try {
			const apiSignature = url.searchParams.get('api-signature');
			const apiExpires = url.searchParams.get('api-expires');
			const auth = await require('hollaex-tools-lib').security.verifyHmacTokenPromise(hmacKey, apiSignature, apiExpires, 'CONNECT', '/stream');
			ws.auth = auth;
			ws.send(JSON.stringify({ message: WS_USER_AUTHENTICATED(ws.auth.sub.email) }));
		} catch (err) {
			loggerWebsocket.verbose('ws/connection hmac auth failed', err.message);
		}
	}

	ws.send(JSON.stringify({ message: WS_WELCOME }));

	ws.on('message', async (message) => {
		try {
			const data = JSON.parse(message);
			const op = data.op;

			if (!op) {
				ws.send(JSON.stringify({ error: WS_MISSING_HEADER }));
				return;
			}

			switch (op) {
				case 'subscribe':
					if (data.args && data.args.length > 0) {
						for (const arg of data.args) {
							const [topic, symbol] = arg.split(':');
							try {
								initializeTopic(topic, ws, symbol);
								loggerWebsocket.verbose(ws.id, 'ws/connection subscribed', arg);
							} catch (err) {
								ws.send(JSON.stringify({ op: 'subscribe', error: err.message }));
							}
						}
					}
					break;
				case 'unsubscribe':
					if (data.args && data.args.length > 0) {
						for (const arg of data.args) {
							const [topic, symbol] = arg.split(':');
							try {
								terminateTopic(topic, ws, symbol);
							} catch (err) {
								ws.send(JSON.stringify({ op: 'unsubscribe', error: err.message }));
							}
						}
					}
					break;
				case 'auth':
					if (data.args && data.args.length > 0) {
						try {
							await authorizeUser(data.args[0], ws, ip);
						} catch (err) {
							ws.send(JSON.stringify({ op: 'auth', error: err.message }));
						}
					}
					break;
				case 'chat':
					if (data.args && data.args.length > 0) {
						try {
							handleChatData(data.args[0], ws, data.args[1]);
						} catch (err) {
							ws.send(JSON.stringify({ op: 'chat', error: err.message }));
						}
					}
					break;
				case 'p2pChat':
					if (data.args && data.args.length > 0) {
						try {
							handleP2pData(data.args[0], ws, data.args[1]);
						} catch (err) {
							ws.send(JSON.stringify({ op: 'p2pChat', error: err.message }));
						}
					}
					break;
				case 'ping':
					ws.send(JSON.stringify({ op: 'pong' }));
					break;
				default:
					ws.send(JSON.stringify({ error: WS_UNSUPPORTED_OPERATION }));
					break;
			}
		} catch (err) {
			loggerWebsocket.error('ws/connection message err', err.message);
			ws.send(JSON.stringify({ error: WS_WRONG_INPUT }));
		}
	});

	ws.on('close', () => {
		loggerWebsocket.info('ws/connection closed', ws.id);
		terminateClosedChannels(ws);
	});

	ws.on('error', (err) => {
		loggerWebsocket.error('ws/connection error', ws.id, err.message);
	});
});

setWsHeartbeat(wss, () => {}, 60000);

connect();
