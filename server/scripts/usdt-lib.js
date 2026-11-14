'use strict';

// Shared configuration for the USDT (ERC-20 on Ethereum) operational scripts.
//
// Mirrors lbtc-ops-env.js: scripts run from systemd on the host, from the API
// container and by hand, so credentials come from the environment, never from
// literals in the source. Env files are read in order and never override a
// value that is already set:
//
//   1. $USDT_OPS_ENV_FILE
//   2. /etc/lbtc-ops/usdt-ops.env         (USDT config + hot wallet key, 0600)
//   3. /etc/lbtc-ops/lbtc-ops.env         (shares the exchange DB credentials)
//   4. /app/forkex/.env
//
// Token parameters (doc186/doc187):
//   USDT ERC-20 on Ethereum mainnet, contract
//   0xdAC17F958D2ee523a2206206994597C13D831ec7, decimals = 6 — NOT 18. A
//   decimals mistake here moves every amount by 10^12.

const fs = require('fs');

const ENV_FILES = [
    process.env.USDT_OPS_ENV_FILE,
    '/etc/lbtc-ops/usdt-ops.env',
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
            `/etc/lbtc-ops/usdt-ops.env (загружены: ${loaded.join(', ') || 'нет'})`
        );
    }
    return v;
}

const USDT_CONTRACT = process.env.USDT_CONTRACT || '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_DECIMALS = Number(process.env.USDT_DECIMALS || 6);
const USDT_COIN_ID = Number(process.env.USDT_COIN_ID || 27);
const USDT_CURRENCY = 'usdt';
const USDT_NETWORK = 'eth';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// keccak256("Approval(address,address,uint256)") — kept so an approval pointed
// at a deposit address can be journalled for the audit trail. Approvals move
// no money by themselves and are never credited.
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3ca0315c67ebbb6ce6f7c315016e3e4b2';

// A customer deposit is credited only when this many confirmations are on the
// block that contains it (doc186: "дождаться нужного количества подтверждений
// перед зачислением баланса").
const DEPOSIT_CONFIRMATIONS = Math.max(1, Number(process.env.USDT_DEPOSIT_CONFIRMATIONS || 12));

// ETH units: the gas of every USDT movement is paid in ETH, never in USDT.
const ETH_CURRENCY = 'eth';

function rpcUrl() {
    return process.env.ETH_RPC_URL || requireVar('ETH_RPC_URL');
}

// Credentials for the exchange database: USDT_DB_* wins, then LBTC_DB_* (the
// same exchange DB), then the application's own DB_*.
function dbConfig() {
    const user = process.env.USDT_DB_USER || process.env.LBTC_DB_USER || process.env.DB_USERNAME || requireVar('USDT_DB_USER');
    const password = process.env.USDT_DB_PASSWORD || process.env.LBTC_DB_PASSWORD || process.env.DB_PASSWORD || requireVar('USDT_DB_PASSWORD');
    return {
        host: process.env.USDT_DB_HOST || process.env.LBTC_DB_HOST || process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.USDT_DB_PORT || process.env.LBTC_DB_PORT || process.env.DB_PORT || 5434),
        database: process.env.USDT_DB_NAME || process.env.LBTC_DB_NAME || process.env.DB_NAME || 'hollaex',
        user,
        password
    };
}

// --- JSON-RPC over HTTP (fetch) ---------------------------------------------

let rpcId = 0;

// Some public endpoints (publicnode, for example) only serve a recent block
// window and reject older ranges with an "archive" error. Deep catch-up scans
// (a monitor that was down for hours) still need the old logs, so errors that
// look like archive/window limits are retried once against the archive
// endpoint. Leave USDT_ARCHIVE_RPC_URL empty to disable the fallback.
function archiveRpcUrl() {
    return process.env.USDT_ARCHIVE_RPC_URL || 'https://eth.drpc.org';
}

function looksLikeArchiveError(message) {
    return /archive|window|too far in the past|missing trie|pruned|beyond head/i.test(String(message));
}

async function rpcAt(url, method, params = [], { retries = 3 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
            });
            if (res.status === 429) throw new Error(`RPC ${method}: rate limited (429)`);
            const json = await res.json();
            if (json.error) throw new Error(`RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`);
            return json.result;
        } catch (e) {
            lastErr = e;
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 750 * (attempt + 1)));
            }
        }
    }
    throw lastErr;
}

async function rpc(method, params = [], { retries = 3 } = {}) {
    const url = rpcUrl();
    try {
        return await rpcAt(url, method, params, { retries });
    } catch (e) {
        const fallback = archiveRpcUrl();
        if (looksLikeArchiveError(e.message) && fallback && fallback !== url) {
            return rpcAt(fallback, method, params, { retries: 1 });
        }
        throw e;
    }
}

// Address -> 32-byte log topic.
function addressTopic(address) {
    return '0x000000000000000000000000' + String(address).toLowerCase().replace(/^0x/, '');
}

// hex -> BigInt
function toBig(hexOrBig) {
    if (typeof hexOrBig === 'bigint') return hexOrBig;
    if (typeof hexOrBig === 'number') return BigInt(hexOrBig);
    return BigInt(hexOrBig);
}

// Base units (6 decimals) -> numeric text with 8 fraction digits, the same
// numeric scale user_wallets/balances use.
function baseToAmountText(base) {
    const b = typeof base === 'bigint' ? base : BigInt(base);
    const whole = b / 1000000n;
    const frac = b % 1000000n;
    return `${whole}.${frac.toString().padStart(6, '0')}0000`.slice(0, 21);
}

// Human amount (e.g. "12.5") -> base units bigint. Rejects more precision
// than the token has instead of silently rounding money.
function amountToBase(amount) {
    const s = String(amount).trim();
    if (!/^\d+(\.\d{0,6})?$/.test(s)) {
        throw new Error(`bad USDT amount "${amount}" (max 6 decimals)`);
    }
    const [w, f = ''] = s.split('.');
    return BigInt(w) * 1000000n + BigInt((f + '000000').slice(0, 6));
}

module.exports = {
    ENV_FILES, loadedEnvFiles: loaded, requireVar,
    USDT_CONTRACT, USDT_DECIMALS, USDT_COIN_ID, USDT_CURRENCY, USDT_NETWORK,
    TRANSFER_TOPIC, APPROVAL_TOPIC, DEPOSIT_CONFIRMATIONS, ETH_CURRENCY,
    rpcUrl, rpc, dbConfig,
    addressTopic, toBig, baseToAmountText, amountToBase
};
