#!/usr/bin/env node
'use strict';
const http = require('http');

const RPC_URL = process.env.LEGACYCOIN_RPC_URL || 'http://127.0.0.1:19556';
const RPC_USER = process.env.LEGACYCOIN_RPC_USER || 'coin';
const RPC_PASS = process.env.LEGACYCOIN_RPC_PASS || 'coin';
const WALLET = process.env.LBTC_USER_WALLET || 'users';
const WITHDRAWAL = process.env.LBTC_WITHDRAWAL_ADDR || 'LbatPBt1z7jTp6u4ikgbRL46XLRtA6ZaxX';

function rpc(method, params, wallet) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: Date.now(), method, params });
    const url = new URL(RPC_URL);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(RPC_USER + ':' + RPC_PASS).toString('base64'),
      'Content-Length': Buffer.byteLength(body)
    };
    if (wallet) headers['X-LegacyCoin-Wallet'] = wallet;
    const req = http.request({ hostname: url.hostname, port: url.port, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Safety net for the monitor's sweep-on-credit. Anything with a spendable
// balance left in the scanned node wallet (a deposit credited while the monitor
// was down, a re-org, a sweep that failed) is moved into the staging float.
async function main() {
  const dry = process.argv.includes('--dry-run');
  const utxos = await rpc('listunspent', [0, 9999999], WALLET);
  const byAddr = new Map();
  for (const u of utxos) {
    if (!(u.amount > 0)) continue;
    byAddr.set(u.address, (byAddr.get(u.address) || 0) + u.amount);
  }
  if (byAddr.size === 0) {
    console.log('nothing to sweep');
    return;
  }
  for (const [address, amount] of byAddr) {
    try {
      if (dry) { console.log('DRY sweep', address, amount); continue; }
      const res = await rpc('sweepallraw', [address, WITHDRAWAL, 1000], WALLET);
      console.log('swept', address, amount, '->', WITHDRAWAL, res.txid);
    } catch (e) { console.error('ERR', address, e.message); }
  }
}

main().catch(e=>{console.error(e);process.exit(1);});
