'use strict';

const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const jwt = require('jsonwebtoken');
const loggerWs = {
    info:  (...args) => console.log('[WS][INFO]',  ...args),
    warn:  (...args) => console.warn('[WS][WARN]',  ...args),
    error: (...args) => console.error('[WS][ERROR]', ...args),
    verbose: (...args) => {
        if (process.env.WS_VERBOSE === '1') {
            console.log('[WS][VERBOSE]', ...args);
        }
    }
};
const { redis, redisSub } = require('./redis');
const axios = require('axios');

const PORT = process.env.WS_PORT || 10011;
const JWT_SECRET =
    process.env.SECRET ||
    process.env.SECRET_KEY;


class UnifiedWSServer {
    constructor() {
        this.server = http.createServer((req, res) => {
            // Health check endpoint
            if (req.url === '/health' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
                return;
            }
            
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        });
        
        this.wss = new WebSocket.Server({ 
            noServer: true,
            clientTracking: true,
            perMessageDeflate: false
        });
        this.setupRedisPubSub();
        this.clients = new Map();
        this.channels = new Map();
        
        this.setupServer();
        this.server.listen(PORT, '0.0.0.0', () => {
            loggerWs.info(`Unified WebSocket server listening on port ${PORT}`);
        });
    }
    
    generateClientId() {
        return (
            Date.now().toString(36) +
            '-' +
            Math.random().toString(36).substring(2, 10)
        );
    }

    setupServer() {
        // Обработка upgrade запросов
        this.server.on('upgrade', (req, socket, head) => {
            const pathname = url.parse(req.url).pathname;
            
            if (pathname === '/stream') {
                this.wss.handleUpgrade(req, socket, head, (ws) => {
                    this.wss.emit('connection', ws, req);
                });
            } else {
                socket.destroy();
            }
        });
        
        // WebSocket соединения
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });
        
        // Ошибки сервера
        this.wss.on('error', (error) => {
            loggerWs.error('WebSocket server error:', error);
        });
        
        // Heartbeat  временно
        //this.setupHeartbeat();
        
        this.startDataPolling();
    }
    
    async handleConnection(ws, req) {
        const clientId = this.generateClientId();
        const ip = req.socket.remoteAddress;
        const parsedUrl = url.parse(req.url, true);
        
        loggerWs.info(`New connection: ${clientId} from ${ip}`);
        
        // Аутентификация
        let userId = null;
        let userData = null;
        let isAuthenticated = false;
        
        try {
            // Токен из query параметров (для браузеров)
            //const queryToken = parsedUrl.query.authorization || parsedUrl.query.token;
            const queryToken =
                parsedUrl.query.token ||
                parsedUrl.query.authorization ||
                parsedUrl.query.auth;
            // Токен из заголовков (для внутренних сервисов)
            const headerToken = req.headers['authorization'];
            const token = queryToken || headerToken;
            if (token) {
                const cleanToken = token.replace('Bearer ', '');
                userData = jwt.verify(cleanToken, JWT_SECRET);
                userId = userData.sub?.id || userData.user_id;
                isAuthenticated = true;
                loggerWs.verbose(`Authenticated: user ${userId} (${userData.sub?.email || userData.email})`);
            }
        } catch (err) {

            loggerWs.warn(`Auth failed for ${clientId}:`, err.message);
        }
        // Сохраняем клиента
        this.clients.set(clientId, {
            ws,
            userId,
            userData,
            ip,
            channels: new Set(),
            authenticated: isAuthenticated,
            isAlive: true,
            type: req.headers['user-agent'] ? 'browser' : 'service'
        });
        ws.clientId = clientId;
        // Heartbeat
        ws.on('pong', () => {
            const client = this.clients.get(clientId);
            if (client) client.isAlive = true;
        });
        
        // Сообщения
        ws.on('message', (data) => {
            this.handleMessage(clientId, data);
        });
        
        // Закрытие
        ws.on('close', () => {
            this.handleDisconnect(clientId);
        });
        
        // Ошибки
        ws.on('error', (error) => {
            loggerWs.error(`Error for ${clientId}:`, error.message);
        });
        
        // Приветственное сообщение
        ws.send(JSON.stringify({
            op: 'connected',
            clientId,
            userId,
            authenticated: isAuthenticated,
            timestamp: Date.now(),
            message: 'Connected to ForkEx WebSocket server'
        }));
        
        // Автоматическая подписка на публичные каналы
/*
        if (isAuthenticated) {
            // Для аутентифицированных пользователей
            this.subscribeToChannels(clientId, ['price', 'trade:*']);
            this.sendInitialTrades(clientId); //  ВАЖНО
            // Отправляем клиенту
            //const client = this.clients.get(clientId);
            //client.ws.send(clientId, readyMessage);
            //console.log(`Sent pairsTradesFetched=true to client ${clientId}`);
        } else {
            // Для анонимных - только публичные данные
            this.subscribeToChannels(clientId, ['price']);
        }
        setTimeout(() => {
            if (this.clients.has(clientId)) {
                    this.sendInitialTrades(clientId);
            }
        }, 100);
*/
    }
    
    handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return;
        
        try {
            const message = JSON.parse(data.toString());
            
            switch (message.op) {
                case 'ping':
                    client.ws.send(JSON.stringify({ op: 'pong', timestamp: Date.now() }));
                    break;
                    
                case 'auth':
                    this.handleAuth(clientId, message);
                    break;
                    
                case 'subscribe':
                    this.handleSubscribe(clientId, message);
                    break;
                    
                case 'unsubscribe':
                    this.handleUnsubscribe(clientId, message);
                    break;
                    
                case 'publish':
                    this.handlePublish(clientId, message);
                    break;
                    
                default:
                    loggerWs.warn(`Unknown op from ${clientId}:`, message.op);
                    client.ws.send(JSON.stringify({
                        op: 'error',
                        error: `Unknown operation: ${message.op}`
                    }));
            }
            
        } catch (err) {
            loggerWs.error(`Message error from ${clientId}:`, err.message);
            client.ws.send(JSON.stringify({ 
                op: 'error', 
                error: 'Invalid message format' 
            }));
        }
    }
    
    handleAuth(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;
        try {
            const token = message.args?.[0]?.replace('Bearer ', '');
            if (!token) throw new Error('No token provided');
            const userData = jwt.verify(token, JWT_SECRET);
            client.userId = userData.sub?.id || userData.user_id;
            client.userData = userData;
            client.authenticated = true;
            loggerWs.info(`Client ${clientId} authenticated as user ${client.userId}`);
            client.ws.send(JSON.stringify({
                op: 'auth',
                status: 'success',
                userId: client.userId,
                timestamp: Date.now()
            }));
            // Автоматически подписываем на приватные каналы
            this.subscribeToPrivateChannels(clientId);
        } catch (err) {
            loggerWs.warn(`Auth failed for ${clientId}:`, err.message);
            client.ws.send(JSON.stringify({
                op: 'auth',
                status: 'error',
                error: 'Authentication failed: ' + err.message
            }));
        }
    }
    
    handleSubscribe(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !message.args || !Array.isArray(message.args)) return;
        
        const channels = message.args;
        const subscribed = [];
        const errors = [];
        
        channels.forEach(channel => {
            try {
                this.validateAndSubscribe(clientId, channel);
                subscribed.push(channel);
            } catch (err) {
                errors.push({ channel, error: err.message });
            }
        });
        
        // Отправляем результат
        client.ws.send(JSON.stringify({
            op: 'subscription_result',
            subscribed,
            errors: errors.length > 0 ? errors : undefined,
            timestamp: Date.now()
        }));
    }
    
    validateAndSubscribe(clientId, channel) {
        const client = this.clients.get(clientId);
        if (!client) throw new Error('Client not found');
        
        // Проверка приватных каналов
        if (channel.startsWith('wallet:') || 
            channel.startsWith('order:') || 
            channel.startsWith('deposit:')) {
            
            if (!client.authenticated) {
                throw new Error('Authentication required for private channel');
            }
            
            const [, channelUserId] = channel.split(':');
            if (channelUserId && parseInt(channelUserId) !== client.userId) {
                throw new Error('Access denied to this channel');
            }
        }
        
        // Подписываем
        client.channels.add(channel);
        
        if (!this.channels.has(channel)) {
            this.channels.set(channel, new Set());
        }
        this.channels.get(channel).add(clientId);
        
        loggerWs.verbose(`Client ${clientId} subscribed to ${channel}`);
    }
    
    subscribeToChannels(clientId, channels) {
        channels.forEach(channel => {
            try {
                this.validateAndSubscribe(clientId, channel);
            } catch (err) {
                loggerWs.warn(`Auto-subscribe failed for ${clientId} to ${channel}:`, err.message);
            }
        });
    }
    
    subscribeToPrivateChannels(clientId) {
        const client = this.clients.get(clientId);
        if (!client || !client.userId) return;
        
        const privateChannels = [
            `wallet:${client.userId}`,
            `order:${client.userId}`,
            `deposit:${client.userId}`,
            `usertrade:${client.userId}`
        ];
        
        this.subscribeToChannels(clientId, privateChannels);
    }
    
    handleUnsubscribe(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !message.args) return;
        
        const channels = message.args;
        
        channels.forEach(channel => {
            client.channels.delete(channel);
            
            if (this.channels.has(channel)) {
                this.channels.get(channel).delete(clientId);
                
                if (this.channels.get(channel).size === 0) {
                    this.channels.delete(channel);
                }
            }
            
            client.ws.send(JSON.stringify({
                op: 'unsubscribed',
                channel,
                timestamp: Date.now()
            }));
        });
    }
    
    handlePublish(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !client.authenticated) return;
    
        const { channel, data } = message;
    
        redis.publish('ws:broadcast', JSON.stringify({
            channelName: channel,
            payload: data
        }));
    }
        
    broadcast(channel, payload, senderClientId = null) {
        const message = JSON.stringify({
            ...payload,
            channel,
            timestamp: Date.now()
        });
    
        // 1️⃣ точные подписки
        const exactSubs = this.channels.get(channel);
        if (exactSubs) {
            exactSubs.forEach(clientId => {
                if (clientId === senderClientId) return;
                this.safeSend(clientId, message);
            });
        }
    
        // 2️⃣ wildcard-подписки
        this.channels.forEach((clientSet, subscribedChannel) => {
            if (!subscribedChannel.includes('*')) return;
    
            if (this.matchWildcard(subscribedChannel, channel)) {
                clientSet.forEach(clientId => {
                    if (clientId === senderClientId) return;
                    this.safeSend(clientId, message);
                });
            }
        });
    }
    matchWildcard(pattern, channel) {
        // trade:* → trade:
        const prefix = pattern.replace('*', '');
        return channel.startsWith(prefix);
    }
    safeSend(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;

        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
        }
    }
    
    handleDisconnect(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;
    
        // Удаляем из каналов
        client.channels.forEach(channel => {
            const subs = this.channels.get(channel);
            if (subs) {
                subs.delete(clientId);
                if (subs.size === 0) {
                    this.channels.delete(channel);
                }
            }
        });
    
        this.clients.delete(clientId);
        loggerWs.info(`Client disconnected: ${clientId}`);
    }
    
    setupRedisPubSub() {
        redisSub.subscribe('ws:broadcast');
    
        redisSub.on('message', (channel, message) => {
            if (channel !== 'ws:broadcast') return;
    
            const { channelName, payload } = JSON.parse(message);
            this.broadcast(channelName, payload);
        });
    
        loggerWs.info('Redis PubSub connected');
    }

    startDataPolling() {
        const API_URL = process.env.PUBLIC_API_URL || process.env.NETWORK_URL || 'http://forkex-api:10010';
        const POLL_INTERVAL = 3000;

        const fetchAndBroadcast = async () => {
            try {
                const pairsRes = await axios.get(`${API_URL}/v2/constants`, { timeout: 5000 });
                const pairs = Object.keys(pairsRes.data.pairs || {});

                for (const symbol of pairs) {
                    try {
                        const obRes = await axios.get(`${API_URL}/v2/orderbook/${symbol}`, { timeout: 3000 });
                        if (obRes.data) {
                            const payload = {
                                topic: 'orderbook',
                                symbol,
                                action: 'partial',
                                data: {
                                    bids: obRes.data.bids || [],
                                    asks: obRes.data.asks || []
                                }
                            };
                            this.broadcast(`orderbook:${symbol}`, payload);
                        }
                    } catch (_) {}

                    try {
                        const tradeRes = await axios.get(`${API_URL}/v2/trades?symbol=${symbol}`, { timeout: 3000 });
                        if (tradeRes.data && tradeRes.data.data) {
                            const payload = {
                                topic: 'trade',
                                symbol,
                                action: 'partial',
                                data: tradeRes.data.data.slice(0, 50),
                                time: Date.now()
                            };
                            this.broadcast(`trade:${symbol}`, payload);
                        }
                    } catch (_) {}
                }
            } catch (err) {
                loggerWs.error('Polling error:', err.message);
            }
        };

        fetchAndBroadcast();
        setInterval(fetchAndBroadcast, POLL_INTERVAL);
        loggerWs.info(`Data polling started every ${POLL_INTERVAL}ms from ${API_URL}`);
    }
    
    async sendInitialTrades(clientId) {
        const pairs = await this.getActivePairs(); // ['btc-usdt', 'eth-usdt']
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) {
            loggerWs.warn(`Client ${clientId} disconnected before initial trades`);
            return;
        }
    
    for (const symbol of pairs) {
            console.log(`trade ${clientId} ${symbol.name}`);
            //const trades = await this.tradeService.getLastTrades(symbol, 50);
            //if (!trades || !trades.length) continue;
            client.ws.send(JSON.stringify({
                op: 'data',
                channel: `trade:${symbol.name}`,
                action: 'partial',
                data: []
            }));

        }
// И сразу:

const message = JSON.stringify({
    event: 'INIT',
    data: { pairs_trades_fetched: true }
});
client.ws.send(message); // где ws - это WebSocket соединение

client.ws.send(JSON.stringify({
    op: 'data',
    channel: 'meta',
    data: {
        pairs_trades_fetched: true
    },
    timestamp: Date.now()
}));

console.log('2.Sent INIT with pairs_trades_fetched=true');
    }
    async getActivePairs() {
        const res = await axios.get(`${process.env.PUBLIC_API_URL}/v2/pairs`, { timeout: 5000 });
        return res.data;
    }

}
new UnifiedWSServer();
