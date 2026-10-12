'use strict';

// Node-owned LBTC deposit addresses.
//
// The exchange must be able to sign for its users' deposit addresses (to sweep
// them into the hot float), so the private key has to live somewhere the node
// controls and that is backed up. The key is derived inside the node's wallet
// through the legacycoreagent; the exchange persists only the address. This
// replaces the old local generate.js path, which returned the key once in the
// API response and never stored it, so every such address was unspendable.
//
// Config (see /app/forkex/.env):
//   LBTC_AGENT_HOST   (default host.docker.internal)
//   LBTC_AGENT_PORT   (default 8444)
//   LBTC_AGENT_API_KEY
//   LBTC_USER_WALLET  (default "users")  node wallet that holds user deposits

const http = require('http');

const AGENT_HOST = process.env.LBTC_AGENT_HOST || 'host.docker.internal';
const AGENT_PORT = parseInt(process.env.LBTC_AGENT_PORT, 10) || 8444;
const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || '';
const USER_WALLET = process.env.LBTC_USER_WALLET || 'users';

function agentPost(path, body) {
	return new Promise((resolve, reject) => {
		if (!AGENT_KEY) {
			return reject(new Error('LBTC_AGENT_API_KEY is not configured'));
		}
		const payload = JSON.stringify(body || {});
		const req = http.request({
			hostname: AGENT_HOST,
			port: AGENT_PORT,
			path,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Api-Key': AGENT_KEY,
				'Content-Length': Buffer.byteLength(payload)
			}
		}, (res) => {
			let data = '';
			res.on('data', (c) => data += c);
			res.on('end', () => {
				let json;
				try { json = JSON.parse(data); }
				catch (e) { return reject(new Error(`agent: unparsable reply: ${data.slice(0, 200)}`)); }
				if (json.error) return reject(new Error(`agent: ${json.error}`));
				resolve(json.result !== undefined ? json.result : json);
			});
		});
		req.on('error', (e) => reject(new Error(`agent unreachable at ${AGENT_HOST}:${AGENT_PORT}: ${e.message}`)));
		req.write(payload);
		req.end();
	});
}

// Derive a node-owned LBTC address from the configured user wallet. The key
// stays in the node wallet; only the address is returned.
async function createNodeOwnedLbtcAddress(walletName) {
	const wallet = walletName || USER_WALLET;
	const res = await agentPost(`/api/wallet/${encodeURIComponent(wallet)}/newaddress`, {});
	const address = res && (res.address !== undefined ? res.address : res);
	if (typeof address !== 'string' || !address) {
		throw new Error(`agent returned no address: ${JSON.stringify(res).slice(0, 200)}`);
	}
	return address;
}

module.exports = { createNodeOwnedLbtcAddress, userWallet: USER_WALLET };
