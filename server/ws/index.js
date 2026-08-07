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
// Добавьте обработку токена из сообщений
wss.on('connection', (ws, req) => {
    let userToken = null;
    let userId = null;
    
    // Извлекаем токен из URL
    const url = new URL(req.url, 'http://localhost');
    const urlToken = url.searchParams.get('authorization');
    
    if (urlToken) {
        userToken = urlToken.replace('Bearer ', '');
        try {
            const decoded = verifyToken(userToken);
            userId = decoded.sub.id;
            ws.userId = userId;
            ws.authenticated = true;
        } catch (err) {
            // Токен невалиден, но соединение остается
        }
    }
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            // Обработка аутентификации через сообщение
            if (data.op === 'auth' && data.args && data.args[0]) {
                const token = data.args[0].replace('Bearer ', '');
                const decoded = verifyToken(token);
                userId = decoded.sub.id;
                ws.userId = userId;
                ws.authenticated = true;
                ws.send(JSON.stringify({
                    op: 'auth',
                    status: 'success',
                    user_id: userId
                }));
                return;
            }
            // Проверка аутентификации для приватных каналов
            if (data.op === 'subscribe') {
                const channels = data.args || [];
                for (const channel of channels) {
                    // Проверяем приватные каналы
                    if (channel.startsWith('wallet:') || 
                        channel.startsWith('order:') || 
                        channel.startsWith('deposit:') ||
                        channel === 'wallet' || 
                        channel === 'order') {
                        if (!ws.authenticated) {
                            ws.send(JSON.stringify({
                                op: 'error',
                                error: 'Authentication required for private channels',
                                channel: channel
                            }));
                            return;
                        }
                        // Проверяем, что пользователь подписывается на свои данные
                        if (channel.includes(':') && !channel.endsWith(`:${userId}`)) {
                            ws.send(JSON.stringify({
                                op: 'error',
                                error: 'Access denied',
                                channel: channel
                            }));
                            return;
                        }
                    }
                }
            }
            // Обработка остальных операций...
        } catch (error) {
            console.error('Message processing error:', error);
        }
    });
});

// If no message received within a minute, close connection
setWsHeartbeat(wss, () => {}, 60000);

connect();