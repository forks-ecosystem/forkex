'use strict';

// Node-owned RVN deposit addresses (mirrors lbtc-node-address.js, direct RPC).
//
// The private key is created INSIDE the ravend wallet (docker rvn-core,
// wallet.dat, label 'users') and is backed up with the node data dir; the
// exchange persists only the address. Sweeps/withdrawals sign inside the node,
// so the API never touches keys.
//
// Config (see /etc/lbtc-ops/rvn-ops.env, loaded by ../lib/rvn-rpc.js):
//   RVN_RPC_HOST / RVN_RPC_PORT / RVN_RPC_USER / RVN_RPC_PASSWORD
//   RVN_ADDRESS_LABEL (default 'users')

const { rpc, describeSources } = require('../../../lib/rvn-rpc');

const LABEL = process.env.RVN_ADDRESS_LABEL || 'users';

const createNodeOwnedRvnAddress = async () => {
	const address = await rpc('getnewaddress', LABEL);
	if (typeof address !== 'string' || !address.startsWith('R')) {
		throw new Error(`rvn: unexpected getnewaddress reply: ${JSON.stringify(address).slice(0, 100)} (${describeSources()})`);
	}
	return address;
};

module.exports = { createNodeOwnedRvnAddress };
