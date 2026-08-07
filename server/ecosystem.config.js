'use strict';

const path = require('path');

const watch = process.env.NODE_ENV !== 'production';
const ignore_watch = [
    'logs',
    'node_modules',
    './**/*node_modules',
    'tools',
    'db/functions',
    'db/triggers',
    'storage',
    'package.json',
    'package.json.*',
    'package-lock.json',
    'package-lock.json.*'
];

const max_memory_restart = '4000M';
const node_args = ['--max_old_space_size=4096'];

const api = {
    name: 'api',
    script: path.resolve(__dirname, 'app.js'),
    error_file: '/dev/null',
    out_file: '/dev/null',
    watch,
    ignore_watch,
    exec_mode: 'cluster',
    instance_var: 'INSTANCE_ID',
    instances: '1',
    max_memory_restart,
    node_args,
    env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.API_PORT || 10010,
        REDIS_HOST: process.env.REDIS_HOST || 'forkex-redis',
        DB_HOST: process.env.DB_HOST || 'forkex-db',
        WS_ENABLED: process.env.WS_ENABLED || false,
        WS_URL: process.env.WS_URL || 'ws://forkex-ws:10011/stream'
    }
};

const ws = {
    name: 'ws',
    script: path.resolve(__dirname, 'ws/ws-server.js'),
    error_file: '/dev/null',
    out_file: '/dev/null',
    watch,
    ignore_watch: ignore_watch.concat(['tools', 'queue']),
    max_memory_restart,
    node_args,
    env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.WEBSOCKET_PORT || 10011,
        REDIS_HOST: process.env.REDIS_HOST || 'forkex-redis'
    }
};

const plugins = {
    name: 'plugins',
    script: path.resolve(__dirname, 'plugins/index.js'),
    error_file: '/dev/null',
    out_file: '/dev/null',
    watch,
    ignore_watch,
    exec_mode: 'cluster',
    instance_var: 'INSTANCE_ID',
    instances: '1',
    max_memory_restart,
    node_args,
    env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.PLUGIN_PORT || 10011,
        REDIS_HOST: process.env.REDIS_HOST || 'forkex-redis',
        WS_URL: process.env.WS_URL || 'ws://forkex-ws:10011/stream'
    }
};

// Определяем, какие приложения поднимать
const mode = process.env.DEPLOYMENT_MODE || 'all';
let apps = [];

if (mode === 'all') {
    apps = [api, ws, plugins];
} else {
    if (mode.includes('api')) apps.push(api);
    if (mode.includes('ws')) apps.push(ws);
    if (mode.includes('plugins')) apps.push(plugins);
}

module.exports = {
    apps
};
