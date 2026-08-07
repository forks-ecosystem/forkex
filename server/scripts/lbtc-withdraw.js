'use strict';

const http = require('http');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const bip32 = require('bip32');
const bip39 = require('bip39');
const { Client } = require('pg');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const LBTC_NETWORK = {
    messagePrefix: '\x1cLigercoin Signed Message:\n',
    bip32: { public: 0x0488B21E, private: 0x0488ADE4 },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xB0,
};

const RPC_USER = 'coin';
const RPC_PASS = 'coin';
const RPC_HOST = '127.0.0.1';
const RPC_PORT = 19556;
const CURRENCY = 'lbtc';
const HOT_WALLET_PATH = 'm/44\'/177\'/0\'/0/0';

function rpcCall(method, params = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '1.0', method, params, id: Date.now() });
        const opts = {
            hostname: RPC_HOST,
            port: RPC_PORT,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64'),
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) reject(new Error(json.error.message));
                    else resolve(json.result);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function getBlock(height) {
    const hash = await rpcCall('getblockhash', [height]);
    return rpcCall('getblock', [hash]);
}

function loadHotWallet() {
    const fs = require('fs');
    const walletPath = '/opt/forkex/wallets/lbtc-hot-wallet.json';
    if (!fs.existsSync(walletPath)) throw new Error('Hot wallet file not found: ' + walletPath);
    const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const seed = bip39.mnemonicToSeedSync(wallet.mnemonic);
    const root = bip32.default(ecc).fromSeed(seed);
    const child = root.derivePath(wallet.path);
    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: LBTC_NETWORK });
    return { keyPair, address, privateKey: child.privateKey, publicKey: keyPair.publicKey };
}

function loadKeyPairFromMnemonic(mnemonic, path) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.default(ecc).fromSeed(seed);
    const child = root.derivePath(path || HOT_WALLET_PATH);
    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: LBTC_NETWORK });
    return { keyPair, address, privateKey: child.privateKey, publicKey: keyPair.publicKey };
}

function hash160(buffer) {
    const sha = crypto.createHash('sha256').update(buffer).digest();
    return crypto.createHash('ripemd160').update(sha).digest();
}

function addressToScriptPubKey(address) {
    const decoded = bs58decode(address);
    if (decoded.length !== 25) throw new Error('Invalid address length');
    const version = decoded[0];
    const hash = decoded.slice(1, 21);
    const checksum = decoded.slice(21);
    const expectedChecksum = bs58check(Buffer.concat([Buffer.from([version]), hash]));
    if (!checksum.equals(expectedChecksum)) throw new Error('Invalid address checksum');
    if (version !== LBTC_NETWORK.pubKeyHash) throw new Error('Invalid address version');
    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);
}

function bs58decode(str) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = BigInt(0);
    for (const c of str) {
        const idx = alphabet.indexOf(c);
        if (idx < 0) throw new Error('Invalid base58 character: ' + c);
        result = result * BigInt(58) + BigInt(idx);
    }
    const hex = result.toString(16).padStart(2, '0');
    const bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
    const leadingOnes = str.split('').filter(c => c === '1').length;
    return Buffer.concat([Buffer.alloc(leadingOnes), bytes]);
}

function bs58check(buffer) {
    const sha1 = crypto.createHash('sha256').update(buffer).digest();
    const sha2 = crypto.createHash('sha256').update(sha1).digest();
    return sha2.slice(0, 4);
}

function parseBlockTxids(hexStr) {
    const data = Buffer.from(hexStr, 'hex');
    if (data.length < 80) return [];
    const body = data.subarray(80);
    let offset = 0;
    const { value: count, bytesRead: countLen } = readVarInt(body, offset);
    offset += countLen;
    const txids = [];
    for (let i = 0; i < count; i++) {
        const txStart = offset;
        offset = skipTx(body, offset);
        const txBytes = body.subarray(txStart, offset);
        const h1 = crypto.createHash('sha256').update(txBytes).digest();
        const h2 = crypto.createHash('sha256').update(h1).digest();
        h2.reverse();
        txids.push(h2.toString('hex'));
    }
    return txids;
}

function readVarInt(buf, offset) {
    const b = buf[offset];
    if (b < 0xfd) return { value: b, bytesRead: 1 };
    if (b === 0xfd) return { value: buf.readUInt16LE(offset + 1), bytesRead: 3 };
    if (b === 0xfe) return { value: buf.readUInt32LE(offset + 1), bytesRead: 5 };
    return { value: Number(buf.readBigUInt64LE(offset + 1)), bytesRead: 9 };
}

function skipTx(buf, offset) {
    offset += 4;
    let segwit = false;
    if (buf[offset] === 0x00) { segwit = true; offset += 2; }
    let { value: inCount, bytesRead } = readVarInt(buf, offset); offset += bytesRead;
    for (let i = 0; i < inCount; i++) {
        offset += 36;
        const { value: sl, bytesRead: slb } = readVarInt(buf, offset); offset += slb + sl; offset += 4;
    }
    let { value: outCount, bytesRead: ol } = readVarInt(buf, offset); offset += ol;
    for (let i = 0; i < outCount; i++) {
        offset += 8;
        const { value: sl, bytesRead: slb } = readVarInt(buf, offset); offset += slb + sl;
    }
    if (segwit) {
        for (let i = 0; i < inCount; i++) {
            let { value: stackCount, bytesRead: scl } = readVarInt(buf, offset); offset += scl;
            for (let j = 0; j < stackCount; j++) {
                const { value: il, bytesRead: ilb } = readVarInt(buf, offset); offset += ilb + il;
            }
        }
    }
    offset += 4;
    return offset;
}

// --- UTXO SCANNER ---
// Scans all blocks to find UTXOs for a given address
// Returns array of { txid, vout, value, scriptPubKey, confirmations }

async function scanForUTXOs(address, fromHeight = 0, toHeight = null) {
    const tip = toHeight || await rpcCall('getblockcount');
    if (fromHeight === 0) fromHeight = Math.max(0, tip - 1000);
    const scriptPubKey = addressToScriptPubKey(address);
    const utxos = [];
    const spentOutpoints = new Set();

    console.log(`[UTXO] Scanning blocks ${fromHeight}-${tip} for ${address}`);

    for (let h = fromHeight; h <= tip; h++) {
        const hash = await rpcCall('getblockhash', [h]);
        const block = await getBlock(h);
        const txids = Array.isArray(block.tx) ? block.tx : [];
        if (txids.length === 0 && block.hex) {
            try { txids.push(...parseBlockTxids(block.hex)); } catch (e) {}
        }

        for (const txid of txids) {
            try {
                const tx = await rpcCall('getrawtransaction', [txid, true]);
                // Mark spent outpoints
                for (const vin of (tx.vin || [])) {
                    if (vin.txid) {
                        spentOutpoints.add(`${vin.txid}:${vin.vout}`);
                    }
                }
                // Find outputs to our address
                for (let n = 0; n < (tx.vout || []).length; n++) {
                    const vout = tx.vout[n];
                    const addrs = vout.scriptPubKey?.addresses || [];
                    if (addrs.includes(address)) {
                        const outpoint = `${txid}:${n}`;
                        if (!spentOutpoints.has(outpoint)) {
                            utxos.push({
                                txid,
                                vout: n,
                                value: vout.value,
                                scriptPubKey: vout.scriptPubKey.hex,
                                confirmations: (tx.confirmations || 0),
                                height: h,
                            });
                        }
                    }
                }
            } catch (e) {}
        }
        if (h % 100 === 0) console.log(`[UTXO] Scanned block ${h}/${tip}`);
    }

    // Remove UTXOs that were already spent by later txs in the same scan range
    const unspentUtxos = utxos.filter(u => !spentOutpoints.has(`${u.txid}:${u.vout}`));

    console.log(`[UTXO] Found ${unspentUtxos.length} unspent UTXOs totaling ${unspentUtxos.reduce((s, u) => s + u.value, 0)} LBTC`);
    return unspentUtxos;
}

// --- FAST UTXO SCANNER ---
// Uses a lighter approach: scan from a known block range, track only our address

async function fastScanUTXOs(address, fromHeight = null) {
    const tip = await rpcCall('getblockcount');
    if (fromHeight === null) fromHeight = Math.max(0, tip - 500);
    const scriptPubKeyHex = addressToScriptPubKey(address).toString('hex');
    const utxos = [];
    const spentOutpoints = new Set();

    console.log(`[FastUTXO] Scanning blocks ${fromHeight}-${tip} for ${address}`);

    for (let h = fromHeight; h <= tip; h++) {
        const block = await getBlock(h);
        const txids = Array.isArray(block.tx) ? block.tx : [];
        if (txids.length === 0 && block.hex) {
            try { txids.push(...parseBlockTxids(block.hex)); } catch (e) {}
        }

        for (const txid of txids) {
            try {
                const tx = await rpcCall('getrawtransaction', [txid, true]);
                for (const vin of (tx.vin || [])) {
                    if (vin.txid) spentOutpoints.add(`${vin.txid}:${vin.vout}`);
                }
                for (let n = 0; n < (tx.vout || []).length; n++) {
                    const vout = tx.vout[n];
                    if (vout.scriptPubKey?.hex === scriptPubKeyHex) {
                        const outpoint = `${txid}:${n}`;
                        if (!spentOutpoints.has(outpoint)) {
                            utxos.push({
                                txid,
                                vout: n,
                                value: vout.value,
                                scriptPubKey: vout.scriptPubKey.hex,
                                confirmations: tip - h + 1,
                                height: h,
                            });
                        }
                    }
                }
            } catch (e) {}
        }
    }

    // Remove UTXOs that were already spent by later txs in the same scan range
    const unspentUtxos = utxos.filter(u => !spentOutpoints.has(`${u.txid}:${u.vout}`));

    console.log(`[FastUTXO] Found ${unspentUtxos.length} unspent UTXOs totaling ${unspentUtxos.reduce((s, u) => s + u.value, 0)} LBTC`);
    return unspentUtxos;
}

// --- BUILD RAW TRANSACTION (bitcoinjs-lib v6 / manual signing) ---

function addressToOutputScript(address) {
    const decoded = bs58decode(address);
    if (decoded.length !== 25) throw new Error('Invalid address length');
    const version = decoded[0];
    const hash = decoded.slice(1, 21);
    if (version !== LBTC_NETWORK.pubKeyHash) throw new Error('Invalid address version');
    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.from(hash), Buffer.from([0x88, 0xac])]);
}

function buildAndSignTransaction(utxos, recipientAddress, amount, changeAddress, fee, keyPair) {
    const totalInput = utxos.reduce((s, u) => s + u.value, 0);
    const changeRaw = totalInput - amount - fee;

    if (changeRaw < 0) throw new Error(`Insufficient funds: have ${totalInput}, need ${amount + fee}`);

    const tx = new bitcoin.Transaction();
    tx.version = 2;

    // Add inputs
    const inputScripts = [];
    for (const utxo of utxos) {
        const prevTxHash = Buffer.from(utxo.txid, 'hex').reverse();
        tx.addInput(prevTxHash, utxo.vout);
        inputScripts.push(Buffer.from(utxo.scriptPubKey, 'hex'));
    }

    // Add recipient output
    const amountSat = Math.round(amount * 1e8);
    const recipientScript = addressToOutputScript(recipientAddress);
    tx.addOutput(recipientScript, BigInt(amountSat));

    // Add change output if significant
    if (changeAddress && changeRaw > 0.000005) {
        const changeSat = Math.round(changeRaw * 1e8);
        const changeScript = addressToOutputScript(changeAddress);
        tx.addOutput(changeScript, BigInt(changeSat));
    }

    // Sign each input
    for (let i = 0; i < utxos.length; i++) {
        const utxo = utxos[i];
        const valueSat = BigInt(Math.round(utxo.value * 1e8));
        const signatureHash = tx.hashForSignature(i, inputScripts[i], bitcoin.Transaction.SIGHASH_ALL);
        const hashBuf = Buffer.from(signatureHash);
        const sig = keyPair.sign(hashBuf);
        const derSig = encodeDER(sig);
        // Build scriptSig: push <DER sig + sighash byte> then push <pubkey>
        const sighashByte = Buffer.from([bitcoin.Transaction.SIGHASH_ALL]);
        const combined = Buffer.concat([derSig, sighashByte]);
        const pubkey = Buffer.from(keyPair.publicKey);
        const inputScript = Buffer.concat([
            pushData(combined),
            combined,
            pushData(pubkey),
            pubkey,
        ]);
        tx.setInputScript(i, inputScript);
    }

    return tx;
}

function pushData(data) {
    const len = data.length;
    if (len < 0x4c) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x4c, len]);
    if (len < 0x10000) return Buffer.from([0x4d, len & 0xff, (len >> 8) & 0xff]);
    return Buffer.from([0x4e, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]);
}

function encodeDER(signature) {
    const r = signature.subarray(0, 32);
    const s = signature.subarray(32, 64);
    // Remove leading zeros from r and s
    let rStart = 0;
    while (rStart < r.length - 1 && r[rStart] === 0) rStart++;
    let sStart = 0;
    while (sStart < s.length - 1 && s[sStart] === 0) sStart++;
    const rBytes = r.subarray(rStart);
    const sBytes = s.subarray(sStart);
    // Add leading 0x00 if high bit set
    const rBuf = (rBytes[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), rBytes]) : rBytes;
    const sBuf = (sBytes[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), sBytes]) : sBytes;
    const totalLen = 2 + rBuf.length + 2 + sBuf.length;
    return Buffer.concat([
        Buffer.from([0x30, totalLen]),
        Buffer.from([0x02, rBuf.length]), rBuf,
        Buffer.from([0x02, sBuf.length]), sBuf,
    ]);
}

async function broadcastTransaction(tx) {
    const hex = tx.toHex();
    console.log(`[Broadcast] TX hex (${hex.length} chars): ${hex.substring(0, 80)}...`);
    try {
        const result = await rpcCall('sendrawtransaction', [hex]);
        console.log(`[Broadcast] Success! TXID: ${result}`);
        return result;
    } catch (err) {
        console.error(`[Broadcast] Failed: ${err.message}`);
        throw err;
    }
}

// --- DB HELPERS ---

async function getDbClient() {
    const client = new Client({ host: '127.0.0.1', port: 5454, database: 'hollaex', user: 'admin', password: 'root' });
    await client.connect();
    return client;
}

async function recordWithdrawal(db, userId, amount, txHash, address, fee = 0) {
    await db.query(
        `UPDATE balances SET balance = balance - $1::numeric - $3::numeric, available = available - $1::numeric - $3::numeric, updated_at = NOW()
         WHERE user_id = $2::int AND currency = $4 AND (balance - $1::numeric - $3::numeric) >= 0`,
        [amount, userId, fee, CURRENCY]
    );
    await db.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
         VALUES ($1::int, 'withdrawal', $2::numeric, $4, 'completed', $3::numeric, $4, 'On-chain LBTC withdrawal', NULL, $5, $6, 'lbtc', '{}', NOW(), NOW())`,
        [userId, amount, fee, CURRENCY, txHash, address]
    );
    // Sync user_wallets
    await db.query(
        `UPDATE user_wallets SET balance = b.balance, available = b.available, updated_at = NOW()
         FROM balances b WHERE user_wallets.user_id = b.user_id AND user_wallets.currency = b.currency
         AND user_wallets.user_id = $1::int AND user_wallets.currency = $2`,
        [userId, CURRENCY]
    );
    console.log(`[DB] Recorded withdrawal: ${amount} LBTC to ${address}, tx: ${txHash}`);
}

// --- MAIN WITHDRAWAL FUNCTION ---

async function processWithdrawal(recipientAddress, amount, fee = 0.0001) {
    console.log(`\n=== LBTC WITHDRAWAL ===`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Amount: ${amount} LBTC`);
    console.log(`Fee: ${fee} LBTC`);

    // Load hot wallet
    const wallet = loadHotWallet();
    console.log(`Hot wallet: ${wallet.address}`);

    // Scan UTXOs
    const utxos = await fastScanUTXOs(wallet.address);
    if (utxos.length === 0) throw new Error('No UTXOs found for hot wallet');

    const totalAvailable = utxos.reduce((s, u) => s + u.value, 0);
    console.log(`Available: ${totalAvailable} LBTC in ${utxos.length} UTXOs`);

    if (totalAvailable < amount + fee) {
        throw new Error(`Insufficient funds: have ${totalAvailable}, need ${amount + fee}`);
    }

    // Sort UTXOs by value (largest first for efficiency)
    utxos.sort((a, b) => b.value - a.value);

    // Select UTXOs (use smallest number of inputs)
    let selectedUtxos = [];
    let selectedTotal = 0;
    for (const utxo of utxos) {
        selectedUtxos.push(utxo);
        selectedTotal += utxo.value;
        if (selectedTotal >= amount + fee) break;
    }

    console.log(`Selected ${selectedUtxos.length} UTXOs totaling ${selectedTotal} LBTC`);

    // Build and sign
    const tx = buildAndSignTransaction(selectedUtxos, recipientAddress, amount, wallet.address, fee, wallet.keyPair);
    console.log(`Raw TX: ${tx.toHex().substring(0, 100)}...`);

    // Broadcast
    const txid = await broadcastTransaction(tx);

    // Record in DB (deduct from hot wallet user_id=1)
    const db = await getDbClient();
    try {
        await recordWithdrawal(db, 1, amount, txid, recipientAddress, fee);
    } finally {
        await db.end();
    }

    console.log(`\n=== WITHDRAWAL COMPLETE ===`);
    console.log(`TXID: ${txid}`);
    console.log(`Amount: ${amount} LBTC`);
    console.log(`To: ${recipientAddress}`);
    console.log(`Fee: ${fee} LBTC`);
    console.log(`Explorer: http://127.0.0.1:8083/tx/${txid}`);

    return { txid, amount, fee, address: recipientAddress };
}

// --- CLI ---

async function main() {
    const args = process.argv.slice(2);

    if (args[0] === 'utxos') {
        const addr = args[1] || loadHotWallet().address;
        const from = parseInt(args[2]) || 0;
        const utxos = await fastScanUTXOs(addr, from);
        for (const u of utxos) {
            console.log(`  ${u.value} LBTC | tx:${u.txid}:${u.vout} | confs:${u.confirmations}`);
        }
        return;
    }

    if (args[0] === 'send') {
        if (args.length < 3) {
            console.log('Usage: node lbtc-withdraw.js send <address> <amount> [fee]');
            process.exit(1);
        }
        const address = args[1];
        const amount = parseFloat(args[2]);
        const fee = parseFloat(args[3]) || 0.0001;
        await processWithdrawal(address, amount, fee);
        return;
    }

    if (args[0] === 'balance') {
        const wallet = loadHotWallet();
        console.log(`Hot wallet address: ${wallet.address}`);
        const utxos = await fastScanUTXOs(wallet.address);
        const total = utxos.reduce((s, u) => s + u.value, 0);
        console.log(`Confirmed balance: ${total} LBTC`);
        console.log(`UTXOs: ${utxos.length}`);
        for (const u of utxos) {
            console.log(`  ${u.value} LBTC | tx:${u.txid}:${u.vout} | confs:${u.confirmations}`);
        }
        return;
    }

    console.log('LBTC Withdrawal Tool');
    console.log('Usage:');
    console.log('  node lbtc-withdraw.js balance                           - Show hot wallet balance');
    console.log('  node lbtc-withdraw.js utxos [address] [fromHeight]      - List UTXOs');
    console.log('  node lbtc-withdraw.js send <address> <amount> [fee]     - Send LBTC');
}

main().catch(err => { console.error(err); process.exit(1); });

module.exports = { processWithdrawal, loadHotWallet, fastScanUTXOs, buildAndSignTransaction, broadcastTransaction };
