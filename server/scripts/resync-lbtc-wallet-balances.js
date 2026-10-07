#!/usr/bin/env node
// Resync user_wallets.balance from the chain for LBTC.
//
// The chain is the source of truth. HollaEx's own [Scanner] wrote user 1's
// whole wallet set to a single value at 2026-09-27 23:01:51.612396, so the DB
// stopped matching the chain. This restores the DB to the chain.
//
// Rules:
//   - balance always follows the chain.
//   - available follows the chain only where it currently equals balance
//     (no reservation held). Where available < balance a real trade lock is in
//     place, so available is left alone -- clobbering it would free funds that
//     are committed to an open order.
'use strict';

const { Client } = require('pg');
const { rpcConfig, dbConfig } = require('./lbtc-ops-env');

const CURRENCY = 'lbtc';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

async function rpc(method, params) {
  const res = await fetch(`http://${RPC.host}:${RPC.port}/`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: 'Basic ' + Buffer.from(`${RPC.user}:${RPC.password}`).toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'r', method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

const RPC = rpcConfig();
const DB_AUTH = dbConfig();
// Same resolution order as check-lbtc-deposits.js: the published port first,
// then the live container IP, since the container is recreated on redeploy and
// its name does not resolve from the host.
function containerIp(name) {
  try {
    return require('child_process')
      .execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${name}`,
        { encoding: 'utf8', timeout: 5000 })
      .trim() || null;
  } catch (e) { return null; }
}

function dbCandidates() {
  const list = [];
  if (process.env.LBTC_MONITOR_DB_HOST) {
    list.push({ host: process.env.LBTC_MONITOR_DB_HOST, port: Number(process.env.LBTC_MONITOR_DB_PORT || 5432) });
  }
  list.push({ host: '127.0.0.1', port: 5434 });
  const ip = containerIp('forkex-db');
  if (ip) list.push({ host: ip, port: 5432 });
  return list;
}

async function connectDb() {
  let last;
  for (const t of dbCandidates()) {
    const cl = new Client({ ...t, ...DB_AUTH, connectionTimeoutMillis: 5000 });
    try { await cl.connect(); await cl.query('select 1'); return cl; }
    catch (e) { last = e; try { await cl.end(); } catch (_) {} }
  }
  throw last;
}

(async () => {
  const db = await connectDb();
  const { rows } = await db.query(
    `SELECT id, user_id, address, balance, available, purpose
       FROM user_wallets WHERE currency = $1 ORDER BY id`, [CURRENCY]);

  console.log(`LBTC кошельков в БД: ${rows.length}   режим: ${APPLY ? 'ПРИМЕНИТЬ' : 'dry-run'}`);
  console.log('  id   user  сеть            БД balance      сеть balance     действие');
  console.log('  ' + '-'.repeat(74));

  const fixes = [];
  for (const r of rows) {
    const b = await rpc('getaddressbalance', [r.address]);
    const chain = Number(b.balance || 0);
    const dbBal = Number(r.balance || 0);
    const dbAvail = Number(r.available || 0);
    const balOff = Math.abs(dbBal - chain) > 1e-8;
    if (!balOff) { console.log(`  ${String(r.id).padEnd(4)} ${String(r.user_id).padEnd(5)} ${String(chain).padEnd(16)} ${dbBal.toFixed(8).padEnd(15)} ${'-'.padEnd(17)} совпадает`); continue; }
    const availHasLock = dbAvail < dbBal - 1e-8;
    fixes.push({ id: r.id, user_id: r.user_id, address: r.address, from: dbBal, to: chain, touchAvail: !availHasLock, hasLock: availHasLock });
    console.log(`  ${String(r.id).padEnd(4)} ${String(r.user_id).padEnd(5)} ${String(chain).padEnd(16)} ${dbBal.toFixed(8).padEnd(15)} ${(availHasLock ? 'available<balance, не трогаем' : 'balance+available').padEnd(17)} ИСПРАВИТЬ`);
  }

  console.log('');
  if (!fixes.length) { console.log('Расхождений нет.'); await db.end(); return; }
  console.log(`Исправить нужно строк: ${fixes.length}`);

  if (!APPLY) {
    console.log('DRY-RUN: ничего не изменено. Для применения добавьте --apply');
    await db.end();
    return;
  }

  for (const f of fixes) {
    if (f.touchAvail) {
      await db.query(`UPDATE user_wallets SET balance = $1::numeric, available = $1::numeric, updated_at = NOW() WHERE id = $2`, [f.to, f.id]);
    } else {
      await db.query(`UPDATE user_wallets SET balance = $1::numeric, updated_at = NOW() WHERE id = $2`, [f.to, f.id]);
    }
    console.log(`  id=${f.id} ${f.from.toFixed(8)} -> ${f.to.toFixed(8)}`);
  }
  console.log('Готово.');
  await db.end();
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
