'use strict';

// Shared JSON-RPC client for the LBTC (LegacyCoin) node.
//
// The implementation lives in ../lib/lbtc-rpc.js so that both script trees
// (scripts/ and scripts-2/) use exactly one client. This file is a thin
// re-export kept at the historical path — the many scripts that
// require('./lbtc-rpc') need no changes.
//
// Transport: legacycoreagent (:8444, /api/chain/lbtc/rpc) by default, direct
// node RPC (.cookie -> env credentials) as the transition-safe fallback.
// LBTC_RPC_MODE=node forces direct-node-only.

module.exports = require('../lib/lbtc-rpc');
