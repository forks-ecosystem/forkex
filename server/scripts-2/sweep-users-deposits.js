#!/usr/bin/env node
'use strict';
const { rpc } = require('../lib/lbtc-rpc');

const WALLET = process.env.LBTC_USER_WALLET || 'users';
const WITHDRAWAL = process.env.LBTC_WITHDRAWAL_ADDR || 'LgTbhrJmMWMxKYJMgswjwYDxgGJt23eevj';

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
