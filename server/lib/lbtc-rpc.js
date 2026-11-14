'use strict';

// Unified JSON-RPC client for the LBTC (LegacyCoin) node.
//
// NODE AUTH MODE (since 2026-11-12): the node runs cookie-only — rpcuser/
// rpcpassword were removed from legacycoin.conf, static credentials are
// rejected with 401, and the credential source is the datadir .cookie
// (recreated by the node when missing; survives a plain node restart).
//
// TRANSPORT PRIORITY (the exchange moves off direct node access):
//   1. legacycoreagent (127.0.0.1:8444, X-Api-Key) — POST /api/chain/lbtc/rpc
//      pass-through. The agent talks to the node itself, so scripts never
//      need node credentials and key-export methods are refused there.
//   2. Direct node RPC — the transition-safe fallback for the window when
//      the agent is down or an old binary without the pass-through op is
//      deployed. Auth chain, resolved per request with a 401-walk:
//        a. .cookie from the known datadir paths (tracks node restarts via
//           a fresh read);
//        b. LBTC_RPC_USER + LBTC_RPC_PASSWORD (aliases: LEGACYCOIN_RPC_*,
//           LBTC_RPC_PASS) from the environment.
//
// Set LBTC_RPC_MODE=node to force direct-node-only (no agent hop), e.g. for
// debugging. The default is the agent.
//
// The wallet scope travels unchanged across both transports (X-LegacyCoin-Wallet
// header on the node, `wallet` field on the agent), so multi-wallet scripts
// (users / bots / withdrawal / ...) need no per-call changes.
//
// Env files are loaded through ./lbtc-ops-env (see that module for the load
// order), so the same code runs under systemd, inside the API container and
// by hand.

const fs = require('fs');
const http = require('http');

require('../scripts/lbtc-ops-env'); // side effect: loads the ops env files

const HOST = process.env.LBTC_RPC_HOST || process.env.LEGACYCOIN_RPC_HOST || '127.0.0.1';
const PORT = Number(process.env.LBTC_RPC_PORT || process.env.LEGACYCOIN_RPC_PORT || 19556);

const AGENT_HOST = process.env.LBTC_AGENT_HOST || '127.0.0.1';
const AGENT_PORT = Number(process.env.LBTC_AGENT_PORT || 8444);
const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || process.env.LEGACYCOIN_API_KEY || '';
const AGENT_CHAIN = process.env.LBTC_AGENT_CHAIN || 'lbtc';
// agent (default) -> agent first, node on transport failure; node -> never use the agent.
const MODE = (process.env.LBTC_RPC_MODE || 'agent').toLowerCase();

// Live datadir first, then the legacy paths older deployments still have.
const COOKIE_PATHS = [
    process.env.LBTC_COOKIE_PATH,
    '/home/coin/.legacycoin/.cookie',
].filter(Boolean);

const DEFAULT_TIMEOUT_MS = 20000;
// LBTC_RPC_DEBUG=1 — log which transport served each call (goes to the
// caller's own log: systemd journal, cron mail, console).
const DEBUG = process.env.LBTC_RPC_DEBUG === '1';

let _auth = null; // node Authorization header that has already succeeded once

function describeSources() {
    return `agent ${AGENT_HOST}:${AGENT_PORT} (key ${AGENT_KEY ? 'set' : 'MISSING'}), ` +
        `cookie: [${COOKIE_PATHS.join(', ') || 'none'}], env: ` +
        (process.env.LBTC_RPC_USER || process.env.LEGACYCOIN_RPC_USER
            ? 'LBTC_RPC_USER/LBTC_RPC_PASSWORD set'
            : 'not set');
}

function readCookieHeader() {
    for (const path of COOKIE_PATHS) {
        try {
            const raw = fs.readFileSync(path, 'utf8').trim();
            // Cookie format is "user:salt:pass"; a colon means it is one.
            if (raw.includes(':')) {
                return 'Basic ' + Buffer.from(raw).toString('base64');
            }
        } catch (e) { /* absent or unreadable — try the next source */ }
    }
    return null;
}

// Ordered candidate node Authorization headers, most trusted first. A
// previously working header goes to the front so the 401-walk happens once.
function authChain() {
    const list = [];
    const cookie = readCookieHeader();
    if (cookie) list.push(cookie);

    const user = process.env.LBTC_RPC_USER || process.env.LEGACYCOIN_RPC_USER;
    const pass = process.env.LBTC_RPC_PASSWORD || process.env.LBTC_RPC_PASS || process.env.LEGACYCOIN_RPC_PASS;
    if (user && pass) list.push('Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));

    if (_auth && !list.includes(_auth)) list.unshift(_auth);
    return list;
}

function resetAuth() {
    _auth = null;
}

function httpJson(reqOptions, body, timeoutMs, wallet) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json', ...reqOptions.headers };
        const payload = body || '';
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        if (wallet) headers['X-LegacyCoin-Wallet'] = wallet;
        const req = http.request(
            { ...reqOptions, headers, timeout: timeoutMs },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, data }));
            }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// Agent transport. Returns the RPC result. Marks transport-level failures
// (agent down, old binary, disabled op) with err.agentTransport so the caller
// can fall back to the node; RPC-level node errors are propagated as-is —
// the node would return the same error on a direct call.
async function agentRPC(method, params, wallet, timeoutMs) {
    if (!AGENT_KEY) {
        const e = new Error('agent: no key (set LBTC_AGENT_API_KEY)');
        e.agentTransport = true;
        throw e;
    }
    const body = JSON.stringify({ method, params, wallet: wallet || '' });
    let res;
    try {
        res = await httpJson(
            { hostname: AGENT_HOST, port: AGENT_PORT, path: `/api/chain/${AGENT_CHAIN}/rpc`, method: 'POST',
              headers: { 'X-Api-Key': AGENT_KEY } },
            body, timeoutMs, ''
        );
    } catch (e) {
        const err = new Error(`agent ${AGENT_HOST}:${AGENT_PORT}: ${e.message}`);
        err.agentTransport = true;
        throw err;
    }
    if (res.status === 404 || res.status === 405 || res.status === 503) {
        // Old binary without the pass-through op, or the op disabled.
        const err = new Error(`agent: http ${res.status}: ${res.data.slice(0, 160)}`);
        err.agentTransport = true;
        throw err;
    }
    let j;
    try { j = JSON.parse(res.data); } catch (e) {
        const err = new Error(`agent: unparsable reply http ${res.status}: ${res.data.slice(0, 160)}`);
        err.agentTransport = true;
        throw err;
    }
    if (res.status === 401 || res.status === 403) {
        // Key problems are configuration, not transport — but without a valid
        // key the agent will never answer, so fall back while surfacing why.
        const err = new Error(`agent: http ${res.status}: ${j.error || 'denied'}`);
        err.agentTransport = true;
        throw err;
    }
    if (j.error !== undefined && j.error !== null) {
        throw new Error(j.error.message || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)));
    }
    if (j.result !== undefined) return j.result;
    return j;
}

function rawNodeCall(auth, method, params, wallet, timeoutMs) {
    return httpJson(
        { host: HOST, port: PORT, path: '/', method: 'POST', headers: { Authorization: auth } },
        JSON.stringify({ jsonrpc: '1.0', id: Date.now(), method, params }),
        timeoutMs, wallet
    ).then(({ status, data }) => {
        if (status === 401) {
            const e = new Error(`rpc ${method}: 401 unauthorized`);
            e.authFailed = true; // caller walks down the auth chain
            throw e;
        }
        if (status !== 200) {
            // Node-level errors (e.g. HTTP 429 rate limit) still carry a
            // JSON-RPC error body — surface its message.
            try {
                const j = JSON.parse(data);
                if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
            } catch (e) { if (e.authFailed || e.message) throw e; }
            throw new Error(`rpc ${method}: http ${status}: ${data.slice(0, 200)}`);
        }
        try {
            const parsed = JSON.parse(data);
            if (parsed.error) throw new Error(parsed.error.message);
            return parsed.result;
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw new Error(`rpc ${method}: bad rpc json: ${e.message}: ${data.slice(0, 200)}`);
            }
            throw e;
        }
    });
}

// Direct-node auth chain walk.
function nodeRPC(method, params, wallet, timeoutMs) {
    const walk = (i) => {
        const chain = authChain();
        if (i >= chain.length) {
            return Promise.reject(new Error(
                `rpc ${method}: authorization failed for every credential source (${describeSources()})`
            ));
        }
        return rawNodeCall(chain[i], method, params, wallet, timeoutMs).then(
            (result) => { _auth = chain[i]; return result; },
            (e) => {
                if (e && e.authFailed) {
                    if (_auth === chain[i]) resetAuth();
                    return walk(i + 1);
                }
                throw e;
            }
        );
    };
    return walk(0);
}

/**
 * JSON-RPC call against the LBTC node (via the agent by default).
 * @param {string} method   e.g. 'getbalance', 'listunspent'
 * @param {Array}  params   method parameters
 * @param {string} [wallet] named wallet (X-LegacyCoin-Wallet / agent `wallet`)
 * @param {object} [opts]   { timeout } in ms (default 20000)
 */
function rpc(method, params = [], wallet = '', opts = {}) {
    const timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS;
    if (MODE === 'node') {
        if (DEBUG) console.log(`[lbtc-rpc] transport: node (LBTC_RPC_MODE=node) ${method}`);
        return nodeRPC(method, params, wallet, timeoutMs);
    }

    return agentRPC(method, params, wallet, timeoutMs).then(
        (r) => {
            if (DEBUG) console.log(`[lbtc-rpc] transport: agent ${method}`);
            return r;
        },
        (e) => {
            if (e && e.agentTransport) {
                if (DEBUG) console.log(`[lbtc-rpc] transport: agent FAILED (${e.message}) -> node fallback ${method}`);
                return nodeRPC(method, params, wallet, timeoutMs);
            }
            throw e;
        }
    );
}

module.exports = {
    rpc,
    getAuthHeader: () => _auth || authChain()[0] || null,
    resetAuth,
    resetCache: resetAuth, // doc192 alias
    COOKIE_PATHS,
    RPC_HOST: HOST,
    RPC_PORT: PORT,
    AGENT_HOST,
    AGENT_PORT,
    MODE,
    describeSources,
};
