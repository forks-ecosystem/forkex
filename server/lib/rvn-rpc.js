'use strict';

// Unified JSON-RPC client for the RVN (Ravencoin) node (ravend in docker,
// /home/coin/rvn-core-server-docker). Direct-node only: unlike LBTC there is
// no signing agent — the node wallet IS the hot float (node-owned addresses),
// and the RPC is published on 127.0.0.1 only, so a compromised API container
// still needs host-level access to reach it.
//
// AUTH: static rpcuser/rpcpassword from the ops env chain (ravend in docker
// is configured with static credentials, unlike the LBTC cookie-only node).
//
// ENV FILE CHAIN (first source wins, values never override a set variable —
// same convention as lbtc-ops-env.js / usdt-lib.js):
//   1. $RVN_OPS_ENV_FILE
//   2. /etc/lbtc-ops/rvn-ops.env        (RVN config, 0600)
//   3. /etc/lbtc-ops/lbtc-ops.env       (host-side operator secrets)
//   4. /app/forkex/.env
//
// Vars: RVN_RPC_HOST (default 127.0.0.1), RVN_RPC_PORT (default 8766),
//       RVN_RPC_USER / RVN_RPC_PASSWORD (aliases RAVENCOIN_RPC_*),
//       RVN_RPC_DEBUG=1 — log each call to the caller's log.

const fs = require('fs');
const http = require('http');

const ENV_FILES = [
    process.env.RVN_OPS_ENV_FILE,
    '/etc/lbtc-ops/rvn-ops.env',
    '/etc/lbtc-ops/lbtc-ops.env',
    '/app/forkex/.env',
].filter(Boolean);

const loadedEnvFiles = ENV_FILES.filter(f => {
    let ok = false;
    try {
        const text = fs.readFileSync(f, 'utf8');
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
        ok = true;
    } catch (e) { /* missing file is fine */ }
    return ok;
});

const HOST = process.env.RVN_RPC_HOST || process.env.RAVENCOIN_RPC_HOST || '127.0.0.1';
const PORT = Number(process.env.RVN_RPC_PORT || process.env.RAVENCOIN_RPC_PORT || 8766);
const USER = process.env.RVN_RPC_USER || process.env.RAVENCOIN_RPC_USER || '';
const PASS = process.env.RVN_RPC_PASSWORD || process.env.RAVENCOIN_RPC_PASSWORD || '';
const DEBUG = process.env.RVN_RPC_DEBUG === '1';
const DEFAULT_TIMEOUT_MS = Number(process.env.RVN_RPC_TIMEOUT_MS || 30000);

let rpcId = 0;

function rpcCall(method, params = [], { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = {}) {
    const attempt = (n) => new Promise((resolve, reject) => {
        const payload = JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params });
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64'),
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let json;
                try { json = JSON.parse(data); }
                catch (e) {
                    return reject(new Error(`RVN RPC ${method}: unparsable reply: ${data.slice(0, 200)}`));
                }
                if (json.error) {
                    const err = new Error(`RVN RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`);
                    err.code = json.error.code;
                    // 401-ish auth failures and transient node errors are retried;
                    // business errors (invalid address, insufficient funds) are not.
                    const retryable = res.statusCode === 503 || (json.error.code === -28);
                    if (retryable && n < retries) return resolve(attempt(n + 1));
                    return reject(err);
                }
                resolve(json.result);
            });
        });
        req.on('error', (e) => {
            if (n < retries) return resolve(attempt(n + 1));
            reject(new Error(`RVN RPC ${method}: ${e.message}`));
        });
        req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
        req.write(payload);
        req.end();
    });
    return attempt(0);
}

const rpc = (method, ...params) => rpcCall(method, params);

// Credentials for the exchange database: RVN_DB_* wins, then LBTC_DB_* (the
// same exchange DB), then the application's own DB_* — same chain as
// usdt-lib.js dbConfig().
function dbConfig() {
    const user = process.env.RVN_DB_USER || process.env.LBTC_DB_USER || process.env.DB_USERNAME || '';
    const password = process.env.RVN_DB_PASSWORD || process.env.LBTC_DB_PASSWORD || process.env.DB_PASSWORD || '';
    return {
        host: process.env.RVN_DB_HOST || process.env.LBTC_DB_HOST || process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.RVN_DB_PORT || process.env.LBTC_DB_PORT || process.env.DB_PORT || 5434),
        database: process.env.RVN_DB_NAME || process.env.LBTC_DB_NAME || process.env.DB_NAME || 'hollaex',
        user,
        password,
    };
}

function describeSources() {
    return `node ${HOST}:${PORT} (${USER ? 'user set' : 'user MISSING'}, ` +
        `pass ${PASS ? 'set' : 'MISSING'}), env files: ${loadedEnvFiles.join(', ') || 'none'}`;
}

module.exports = { rpc, rpcCall, dbConfig, describeSources, loadedEnvFiles };
