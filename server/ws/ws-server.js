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
        
        // Redis Pub/Sub  временно
        this.setupRedisPubSub();
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
        if (isAuthenticated) {
            // Для аутентифицированных пользователей
            this.subscribeToChannels(clientId, ['price', 'trade:*']);
            this.sendInitialTrades(clientId); //  ВАЖНО
    
        // ДОБАВИТЬ ЭТО:
            // Отправляем сообщение клиенту о готовности данных
            const readyMessage = JSON.stringify({
                type: 'market_data_ready',
                pairs_trades_fetched: true,
                timestamp: Date.now()
            });
            // Отправляем клиенту
            const client = this.clients.get(clientId);
            client.ws.send(clientId, readyMessage);
            console.log(`Sent pairsTradesFetched=true to client ${clientId}`);
            // ИЛИ: Диспатчим Redux action если на сервере есть доступ к store
            if (typeof store !== 'undefined') {
                store.dispatch({
                    type: 'PAIRS_TRADES_FETCHED',
                    payload: true
                });
            }
        } else {
            // Для анонимных - только публичные данные
            this.subscribeToChannels(clientId, ['price']);
        }
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
            op: 'data',
            channel,
            data: payload,
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
    
    
    async sendInitialTrades(clientId) {
        const { Pair, Coin } = require('./db/models');
    
        const pairs = await Pair.findAll({
            where: {
                active: true,
                is_public: true
            },
            include: [
                { model: Coin, as: 'base_coin', attributes: ['symbol'] },
                { model: Coin, as: 'quote_coin', attributes: ['symbol'] }
            ],
            order: [['id', 'ASC']]
        });
    
        for (const pair of pairs) {
            const symbol =
                `${pair.base_coin.symbol}-${pair.quote_coin.symbol}`.toLowerCase();
    
            const trades = await this.tradeService.getLastTrades(symbol, 50);
    
            if (!trades || !trades.length) continue;
    
            this.sendToClient(clientId, {
                topic: `trade:${symbol}`,
                action: 'partial',
                data: trades
            });
        }
    
        //  ЭТО сообщение фронт НЕ слушает, можно убрать
        // pairsTradesFetched выставляется автоматически при partial
    }
    
}
new UnifiedWSServer();
