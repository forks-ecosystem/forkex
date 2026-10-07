'use strict';

// Shared configuration for the LBTC operational scripts.
//
// These scripts run from three places: systemd on the host, the API container,
// and by hand. Credentials therefore come from the environment, never from
// literals in the source. A missing variable is a hard error: falling back to a
// default would silently re-introduce exactly the hardcoding this module
// replaces.
//
// Env files are read in order and never override a value that is already set,
// so an explicit environment (systemd EnvironmentFile, docker env) always wins:
//
//   1. $LBTC_OPS_ENV_FILE
//   2. /etc/lbtc-ops/lbtc-ops.env          (host-side operator secrets, mode 0600)
//   3. /app/forkex/.env                    (already present, holds DB_* / LBTC_AGENT_*)

const fs = require('fs');

const ENV_FILES = [
    process.env.LBTC_OPS_ENV_FILE,
    '/etc/lbtc-ops/lbtc-ops.env',
    '/app/forkex/.env'
].filter(Boolean);

function loadEnvFile(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return false;
    }
    for (const line of text.split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        let value = m[2];
        if (value.length >= 2 &&
            ((value[0] === '"' && value[value.length - 1] === '"') ||
             (value[0] === "'" && value[value.length - 1] === "'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
    return true;
}

const loaded = ENV_FILES.filter(loadEnvFile);

function requireVar(name) {
    const v = process.env[name];
    if (v === undefined || v === '') {
        throw new Error(
            `${name} не задан. Задайте переменную окружения или добавьте её в ` +
            `/etc/lbtc-ops/lbtc-ops.env (загружены: ${loaded.join(', ') || 'нет'})`
        );
    }
    return v;
}

// Credentials for the node's JSON-RPC.
function rpcConfig() {
    return {
        host: process.env.LBTC_RPC_HOST || '127.0.0.1',
        port: Number(process.env.LBTC_RPC_PORT || 19556),
        user: requireVar('LBTC_RPC_USER'),
        password: requireVar('LBTC_RPC_PASSWORD')
    };
}

// Credentials for the exchange database. LBTC_DB_* wins, then the application's
// own DB_* so the scripts can run inside the API container unchanged.
function dbConfig(fallback = {}) {
    const user = process.env.LBTC_DB_USER || process.env.DB_USERNAME || requireVar('LBTC_DB_USER');
    const password = process.env.LBTC_DB_PASSWORD || process.env.DB_PASSWORD || requireVar('LBTC_DB_PASSWORD');
    return {
        host: process.env.LBTC_DB_HOST || process.env.DB_HOST || fallback.host || '127.0.0.1',
        port: Number(process.env.LBTC_DB_PORT || process.env.DB_PORT || fallback.port || 5432),
        database: process.env.LBTC_DB_NAME || process.env.DB_NAME || fallback.database || 'hollaex',
        user,
        password
    };
}

module.exports = { rpcConfig, dbConfig, requireVar, loadedEnvFiles: loaded };
