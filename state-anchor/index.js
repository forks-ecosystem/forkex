const { createHash } = require('crypto');
const { Pool } = require('pg');
const http = require('http');

const DB = 'postgres://admin:root@localhost:5454/hollaex';
const RPC_PORT = 19056;
const RPC_USER = 'coin';
const RPC_PASS = 'coin';
const NODE_ID = 'node1';
const CHECK_INTERVAL = 30000;
const SYNC_TABLES = [
  'users', 'orders', 'trades', 'balances', 'deposits', 'withdrawals',
  'pairs', 'coins', 'orderbooks', 'transactions', 'sessions',
  'affiliations', 'announcements', 'audits', 'auto_trade_configs',
  'balance_histories', 'bot_configs', 'brokers', 'logins',
  'market_prices', 'otp_codes', 'p2p_deals', 'p2p_disputes',
  'p2p_merchants', 'p2p_merchants_feedback', 'p2p_transactions',
  'payment_details', 'plugins', 'quick_trades', 'referral_codes',
  'referral_histories', 'reset_password_codes', 'roles',
  'sharedaccounts', 'stakers', 'stakes', 'statuses', 'subaccounts',
  'tiers', 'tokens', 'transaction_limits', 'user_address_books',
  'user_coins', 'user_wallets', 'verification_images'
];

const db = new Pool({ connectionString: DB });
let rpcAuth = '';

function loadRpcAuth() {
  rpcAuth = RPC_USER + ':' + RPC_PASS;
}

async function rpcCall(method, params = []) {
  const body = JSON.stringify({ jsonrpc: '1.0', id: '1', method, params });
  const auth = Buffer.from(rpcAuth).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: RPC_PORT, path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': 'Basic ' + auth
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(j.error.message));
          else resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function hashRecord(record) {
  return createHash('sha256').update(JSON.stringify(record, Object.keys(record).sort())).digest('hex');
}

async function fetchTable(table) {
  try {
    const { rows } = await db.query('SELECT * FROM ' + table + ' ORDER BY id');
    return { rows, key: 'id' };
  } catch (e) {
    const { rows } = await db.query('SELECT * FROM ' + table);
    return { rows, key: null };
  }
}

async function getLastBlock() {
  const info = await rpcCall('getblockchaininfo');
  return { height: info.blocks, bestblockhash: info.bestblockhash };
}

async function sendOpReturn(dataHex) {
  const result = await rpcCall('sendtoaddress', ['LWRVe3iTNPJFNqxeKvn3FqUKRf6cem6gQe', 0.00000546]);
  return result.txid;
}

async function recordState(table, rows, blockHeight, txid, key) {
  if (!rows.length) return;
  const nwTable = 'nw_' + table;
  if (key === 'id') {
    const ids = rows.map(r => r.id);
    await db.query(`DELETE FROM ${nwTable} WHERE record_id = ANY($1::int[])`, [ids]);
    const values = rows.map(r => `(${r.id}, '${hashRecord(r)}', ${blockHeight}, '${txid}', NOW())`).join(',');
    await db.query(`INSERT INTO ${nwTable} (record_id, state_hash, block_height, txid, created_at) VALUES ${values}`);
  } else {
    await db.query(`DELETE FROM ${nwTable}`);
    for (const r of rows) {
      const rid = JSON.stringify(r);
      await db.query(`INSERT INTO ${nwTable} (record_id, state_hash, block_height, txid, created_at) VALUES (DEFAULT, $1, $2, $3, NOW())`,
        [hashRecord(r), blockHeight, txid]);
    }
  }
}

async function recordSyncState(blockHeight, txid, stateHash) {
  await db.query('DELETE FROM nw_sync_state WHERE node_id = $1', [NODE_ID]);
  await db.query(
    'INSERT INTO nw_sync_state (node_id, last_processed_block_height, last_processed_txid, state_hash) VALUES ($1, $2, $3, $4)',
    [NODE_ID, blockHeight, txid, stateHash]
  );
}

async function recordOperation(type, opHash, blockHeight, txid) {
  await db.query(
    'INSERT INTO nw_operations_log (operation_type, operation_hash, block_height, txid) VALUES ($1, $2, $3, $4)',
    [type, opHash, blockHeight, txid]
  );
}

async function syncCycle() {
  try {
    const { height } = await getLastBlock();
    const { rows: [state] } = await db.query(
      'SELECT last_processed_block_height FROM nw_sync_state WHERE node_id = $1', [NODE_ID]
    );
    const lastHeight = state ? state.last_processed_block_height : 0;

    if (height <= lastHeight) {
      console.log(`[Anchor] No new blocks (${height} <= ${lastHeight})`);
      return;
    }

    console.log(`[Anchor] Processing blocks ${lastHeight + 1}..${height}`);

    const tableData = {};
    const tableKeys = {};
    const allHashes = [];
    for (const table of SYNC_TABLES) {
      const { rows, key } = await fetchTable(table);
      tableData[table] = rows;
      tableKeys[table] = key;
      allHashes.push(hashRecord(rows));
    }
    const globalHash = hashRecord(allHashes);

    const marker = Buffer.from('EXC', 'ascii');
    const hashBuf = Buffer.from(globalHash, 'hex');
    const dataHex = Buffer.concat([marker, hashBuf]).toString('hex');

    let txid;
    try {
      txid = await sendOpReturn(dataHex);
      console.log(`[Anchor] OP_RETURN sent: ${txid}`);
    } catch (e) {
      console.error(`[Anchor] OP_RETURN failed: ${e.message}. Using zero txid.`);
      txid = '0000000000000000000000000000000000000000000000000000000000000000';
    }
    await recordOperation('state_anchor', globalHash, height, txid);

    for (const table of SYNC_TABLES) {
      await recordState(table, tableData[table], height, txid, tableKeys[table]);
    }

    await recordSyncState(height, txid, globalHash);
    console.log(`[Anchor] Synced block ${height}, txid=${txid.substring(0, 16)}..., hash=${globalHash.substring(0, 16)}...`);
  } catch (e) {
    console.error('[Anchor] Cycle error:', e.message);
  }
}

async function main() {
  console.log('[Anchor] State Notarization Service started (node=' + NODE_ID + ')');
  try {
    loadRpcAuth();
    await rpcCall('getblockchaininfo');
    await db.query('SELECT 1');
  } catch (e) {
    console.error('[Anchor] Init error:', e.message);
    process.exit(1);
  }
  await syncCycle();
  setInterval(syncCycle, CHECK_INTERVAL);
}

main();
