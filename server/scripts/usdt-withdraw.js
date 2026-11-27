'use strict';

// USDT (ERC-20 Ethereum mainnet) WITHDRAWAL — the ERC-20 counterpart of
// lbtc-withdraw.js.
//
// The hot wallet is an EOA: the tokens leave with a `transfer()` call on the
// USDT contract signed by the hot wallet key (kept in
// /etc/lbtc-ops/usdt-ops.env, mode 0600 — never in the source, never in the
// exchange DB). The GAS of every movement — user withdrawal, sweep of a
// customer deposit address, fee move — is paid in ETH, never in USDT, so a
// hot wallet with 0 ETH cannot send anything no matter how many USDT it holds
// (doc186: "токены USDT окажутся заперты... пока вы не пополните кошелёк
// нативной монетой ETH"). `eth-balance` and `eth-send` exist to manage that.
//
// decimals = 6: USDT ERC-20 base unit is 10^-6, NOT 10^-18 (doc187). All
// ledger writes use the 8-fraction numeric scale the exchange already uses.
//
// Run:
//   node usdt-withdraw.js balance                       - USDT + ETH hot wallet
//   node usdt-withdraw.js validate <address>            - address sanity check
//   node usdt-withdraw.js send <address> <amount> [fee] - withdraw USDT (ledger debit + broadcast)
//   node usdt-withdraw.js sweep [min]                   - collect customer deposit addresses into the hot wallet
//   node usdt-withdraw.js eth-balance [address]         - ETH balance (gas)
//   node usdt-withdraw.js eth-send <to> <amountEth>     - send ETH (gas top-up)
//
// Config: /etc/lbtc-ops/usdt-ops.env via usdt-lib.js.

const fs = require('fs');
const { ethers } = require('ethers');
const { dbConfig, rpcUrl, USDT_CONTRACT, USDT_DECIMALS, USDT_COIN_ID, amountToBase } = require('./usdt-lib');

const CURRENCY = 'usdt';
const HOT_USER_ID = Number(process.env.USDT_HOT_USER_ID || 1);
// ERC-20 transfer of a plain token costs ~63k gas; USDT's legacy storage
// layout historically needed more, so 120k is the safe default and
// estimateGas is still authoritative per send.
const DEFAULT_GAS_LIMIT = Number(process.env.USDT_GAS_LIMIT || 120000);
const DEFAULT_GAS_GWEI = Number(process.env.USDT_GAS_GWEI || 3);

// Customer deposit addresses are plain EOAs; a sweep must be signed by the
// key that owns the address, not by the hot wallet. usdt-regen-addresses.js
// writes these keys to wallet-backups, never to the exchange DB.
const CUSTOMER_KEYS_DIR = process.env.USDT_CUSTOMER_KEYS_DIR || '/etc/lbtc-ops/wallet-backups';

const ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
];

function hotWallet() {
    const key = requireVar('USDT_HOT_PRIVATE_KEY');
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl());
    const wallet = new ethers.Wallet(key, provider);
    const token = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, wallet);
    return { wallet, token, provider };
}

function readOnly() {
    // Balance/gas checks must work without the signing key: the monitor and
    // operators still need to see the hot wallet state while the key is not
    // provisioned yet.
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl());
    const token = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, provider);
    return { provider, token, address: String(process.env.USDT_HOT_ADDRESS || '') };
}

function requireVar(name) {
    if (!process.env[name]) {
        throw new Error(`${name} не задан — добавьте его в /etc/lbtc-ops/usdt-ops.env (0600)`);
    }
    return process.env[name];
}

function fmt(n) { return Number(n).toFixed(6); }

async function getDb() {
    const { Client } = require('pg');
    const client = new Client({ ...dbConfig(), connectionTimeoutMillis: 5000 });
    await client.connect();
    return client;
}

// --- address validation -----------------------------------------------------

// EIP-55 checksum + basic shape. There is no `validateaddress` RPC for EVM, so
// this is the gate a recipient address passes before anything is signed.
function validateAddress(address) {
    if (typeof address !== 'string') return { isvalid: false, reason: 'not a string' };
    const a = address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return { isvalid: false, reason: 'must be 0x + 40 hex chars' };
    if (a === a.toLowerCase() || a === a.toUpperCase()) {
        // All-one-case form: no checksum to verify, structurally fine.
        return { isvalid: true, checksum: false, address: a.toLowerCase() };
    }
    try {
        const ok = ethers.utils.getAddress(a) === a;
        return ok
            ? { isvalid: true, checksum: true, address: a.toLowerCase() }
            : { isvalid: false, reason: 'EIP-55 checksum mismatch' };
    } catch (e) {
        return { isvalid: false, reason: e.message };
    }
}

// --- LEDGER -----------------------------------------------------------------

// One row per user+currency: anything other than rowCount 1 means the debit
// did not land and must not be papered over with a broadcast transaction row.
async function recordWithdrawal(db, userId, amount, fee, txHash, address) {
    const upd = await db.query(
        `UPDATE balances
            SET balance = balance - $1::numeric - $2::numeric,
                available = available - $1::numeric - $2::numeric,
                updated_at = NOW()
          WHERE user_id = $3::int AND currency = $4
            AND (balance - $1::numeric - $2::numeric) >= 0`,
        [amount, fee, userId, CURRENCY]
    );
    if (upd.rowCount !== 1) {
        throw new Error(`balance debit for user ${userId} touched ${upd.rowCount} rows, expected 1 (need ${amount} USDT)`);
    }
    await db.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
         VALUES ($1::int, 'withdrawal', $2::numeric, $3, 'completed', $4::numeric, $3, 'On-chain USDT withdrawal', NULL, $5, $6, 'eth', '{}', NOW(), NOW())`,
        [userId, amount, CURRENCY, fee, txHash, address]
    );
    await db.query(
        `INSERT INTO withdrawals (user_id, coin_id, amount, fee, status, address, tx_hash, created_at, updated_at)
         VALUES ($1::int, $2::int, $3::numeric, $4::numeric, 'completed', $5, $6, NOW(), NOW())`,
        [userId, USDT_COIN_ID, amount, fee, address, txHash]
    );
    console.log(`[DB] Recorded withdrawal: ${fmt(amount)} USDT to ${address}, tx: ${txHash}`);
}

async function recordEthMove(db, userId, amountEth, txHash, toAddress, description) {
    // ETH moves are gas management, not customer withdrawals: they debit the
    // exchange's ETH ledger (if a row exists) and journal the movement.
    const upd = await db.query(
        `UPDATE balances
            SET balance = balance - $1::numeric, available = available - $1::numeric, updated_at = NOW()
          WHERE user_id = $2::int AND currency = 'eth' AND (balance - $1::numeric) >= 0`,
        [amountEth, userId]
    );
    if (upd.rowCount !== 1) {
        // No ETH ledger row (or insufficient): journal the move as the
        // exchange's own operation without a customer-facing debit.
        await db.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
             VALUES ($1::int, 'withdrawal', $2::numeric, 'eth', 'completed', 0, '', $3, NULL, $4, $5, 'eth', '{"internal": true}'::jsonb, NOW(), NOW())`,
            [userId, amountEth, description, txHash, toAddress]
        );
        return;
    }
    await db.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, fee, fee_currency, description, reference_id, tx_hash, address, network, metadata, created_at, updated_at)
         VALUES ($1::int, 'withdrawal', $2::numeric, 'eth', 'completed', 0, '', $3, NULL, $4, $5, 'eth', '{"internal": true}'::jsonb, NOW(), NOW())`,
        [userId, amountEth, description, txHash, toAddress]
    );
}

// --- ACTIONS ----------------------------------------------------------------

async function cmdBalance() {
    const { provider, token, address } = readOnly();
    if (!address) throw new Error('USDT_HOT_ADDRESS не задан в /etc/lbtc-ops/usdt-ops.env');
    const [usdtRaw, ethRaw] = await Promise.all([
        token.balanceOf(address),
        provider.getBalance(address),
    ]);
    console.log(`Hot wallet: ${address}`);
    console.log(`USDT: ${fmt(Number(usdtRaw) / 10 ** USDT_DECIMALS)}`);
    console.log(`ETH (gas): ${fmt(Number(ethRaw) / 1e18)}`);
    const keySet = !!process.env.USDT_HOT_PRIVATE_KEY;
    console.log(`Signing key: ${keySet ? 'configured' : 'NOT configured (withdrawals disabled until USDT_HOT_PRIVATE_KEY is set)'}`);
    const db = await getDb();
    try {
        const b = await db.query(
            `SELECT balance, available FROM balances WHERE user_id = $1::int AND currency = $2`,
            [HOT_USER_ID, CURRENCY]
        );
        console.log(`Ledger (user ${HOT_USER_ID}, ${CURRENCY}): ${b.rows.length ? `${Number(b.rows[0].balance)} (available ${Number(b.rows[0].available)})` : 'no row'}`);
    } finally {
        await db.end();
    }
}

async function cmdValidate(address) {
    console.log(JSON.stringify(validateAddress(address), null, 2));
}

async function cmdSend(recipientArg, amountArg, feeArg = '0') {
    const v = validateAddress(recipientArg);
    if (!v.isvalid) throw new Error(`invalid recipient address: ${recipientArg} (${v.reason})`);
    const recipient = v.address;
    const amountBase = amountToBase(amountArg);
    const feeBase = amountToBase(feeArg);
    const amount = amountArg;
    const fee = feeArg;
    if (amountBase <= 0n) throw new Error('amount must be > 0');

    const { wallet, token, provider } = hotWallet();
    const from = (await wallet.getAddress()).toLowerCase();

    console.log(`\n=== USDT WITHDRAWAL (ERC-20, Ethereum mainnet) ===`);
    console.log(`From: ${from}`);
    console.log(`To:   ${recipient}`);
    console.log(`Amount: ${amount} USDT  | fee charged: ${fee} USDT`);

    const [usdtRaw, ethRaw] = await Promise.all([
        token.balanceOf(from),
        provider.getBalance(from),
    ]);
    console.log(`Hot wallet USDT: ${fmt(Number(usdtRaw) / 10 ** USDT_DECIMALS)} | ETH: ${fmt(Number(ethRaw) / 1e18)}`);
    if (usdtRaw < amountBase + feeBase) {
        throw new Error(`hot wallet holds ${fmt(Number(usdtRaw) / 10 ** USDT_DECIMALS)} USDT, need ${fmt(Number(amountBase + feeBase) / 10 ** USDT_DECIMALS)}`);
    }

    const gasPriceGwei = Number(ethers.utils.formatUnits(await provider.getGasPrice(), 'gwei'));
    const gasPrice = ethers.utils.parseUnits(String(Math.max(gasPriceGwei * 1.2, DEFAULT_GAS_GWEI).toFixed(2)), 'gwei');
    let gasLimit;
    try {
        gasLimit = await token.estimateGas.transfer(recipient, amountBase);
        gasLimit = gasLimit.mul(120).div(100); // +20% headroom
    } catch (e) {
        console.log(`estimateGas failed (${e.message.slice(0, 80)}), using default ${DEFAULT_GAS_LIMIT}`);
        gasLimit = ethers.BigNumber.from(DEFAULT_GAS_LIMIT);
    }
    const gasCost = gasLimit.mul(gasPrice);
    console.log(`Gas: ${gasLimit.toString()} @ ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei = ${fmt(Number(gasCost) / 1e18)} ETH`);
    if (ethRaw.lt(gasCost)) {
        throw new Error(`no gas: hot wallet has ${fmt(Number(ethRaw) / 1e18)} ETH, needs ${fmt(Number(gasCost) / 1e18)} ETH. Fund it: node usdt-withdraw.js eth-send ${from} <amountEth>`);
    }

    const nonce = await provider.getTransactionCount(from, 'pending');
    const tx = await token.transfer(recipient, amountBase, { gasLimit, gasPrice, nonce });
    console.log(`[Tx] broadcast ${tx.hash} (nonce ${nonce}), waiting 1 confirmation...`);
    const receipt = await tx.wait(1);
    if (receipt.status !== 1) throw new Error(`transaction reverted on chain: ${tx.hash}`);
    console.log(`[Tx] mined in block ${receipt.blockNumber}: ${tx.hash}`);

    const db = await getDb();
    try {
        await recordWithdrawal(db, HOT_USER_ID, amount, fee, tx.hash, recipient);
    } catch (e) {
        // The broadcast already happened — never bury that. Surface the debit
        // failure loudly so the ledger can be reconciled by hand.
        console.error(`!!! BROADCAST OK but LEDGER WRITE FAILED: ${tx.hash} (${e.message})`);
        throw e;
    } finally {
        await db.end();
    }

    console.log(`\n=== WITHDRAWAL COMPLETE ===`);
    console.log(`TX: ${tx.hash}`);
    console.log(`Explorer: https://etherscan.io/tx/${tx.hash}`);
    return { txHash: tx.hash, amount, fee, address: recipient };
}

// Sweep a customer deposit address into the hot wallet (doc186's sweep/скрипт
// сбора депозитов). Two gates make it safe to run repeatedly:
//   - only customer rows (purpose empty) with balance >= min are touched;
//   - gas is funded from the hot wallet FIRST, and the USDT transfer happens
//     on a later run once the gas has confirmed — so a run never leaves an
//     address half-processed without a trail.
//
// The USDT transfer itself must be signed by the deposit address key: a hot
// wallet signature would try to move the hot wallet's own balance and revert.
function loadCustomerKeys() {
    let file = process.env.USDT_CUSTOMER_KEYS_FILE;
    if (!file) {
        let files = [];
        try {
            files = fs.readdirSync(CUSTOMER_KEYS_DIR)
                .filter((f) => /^usdt-customer-keys-.*\.json$/.test(f))
                .sort();
        } catch (e) {
            console.log(`  cannot read ${CUSTOMER_KEYS_DIR}: ${e.message}`);
        }
        if (files.length) file = `${CUSTOMER_KEYS_DIR}/${files[files.length - 1]}`;
    }
    if (!file) {
        console.log('  no usdt-customer-keys-*.json found: sweeps cannot be signed');
        return new Map();
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = new Map();
    for (const w of data.wallets || []) {
        if (w.address && w.privateKey) keys.set(String(w.address).toLowerCase(), w.privateKey);
    }
    console.log(`  keys: ${keys.size} from ${file}`);
    return keys;
}

async function cmdSweep(minArg) {
    const minBase = amountToBase(minArg || String(process.env.USDT_SWEEP_MIN || '10'));
    const { wallet, token, provider } = hotWallet();
    const hotAddress = (await wallet.getAddress()).toLowerCase();
    const db = await getDb();
    let rows;
    try {
        const res = await db.query(
            `SELECT user_id, address FROM user_wallets
              WHERE currency = $1 AND is_valid = true
                AND address IS NOT NULL AND address <> ''
                AND LOWER(address) LIKE '0x%'
                AND (purpose IS NULL OR purpose = '')
                AND LOWER(address) <> LOWER($2)`,
            [CURRENCY, hotAddress]
        );
        rows = res.rows;
    } finally {
        await db.end();
    }
    console.log(`Sweep: ${rows.length} customer address(es), min ${fmt(Number(minBase) / 10 ** USDT_DECIMALS)} USDT`);
    const keys = loadCustomerKeys();
    const hotGasNeeded = ethers.utils.parseUnits('0.0004', 'ether'); // ~2 sends of headroom
    for (const r of rows) {
        const address = r.address;
        let raw;
        try {
            raw = await token.balanceOf(address);
        } catch (e) {
            console.log(`  ${address}: balanceOf failed (${e.message.slice(0, 60)})`);
            continue;
        }
        if (raw < minBase) continue;
        const amountText = fmt(Number(raw) / 10 ** USDT_DECIMALS);
        const ethRaw = await provider.getBalance(address);
        if (ethRaw.lt(hotGasNeeded)) {
            const need = hotGasNeeded.sub(ethRaw);
            console.log(`  ${address}: ${amountText} USDT — funding ${fmt(Number(need) / 1e18)} ETH for gas (rerun after it confirms)`);
            await cmdEthSendInternal(address, need);
            continue;
        }
        const key = keys.get(address.toLowerCase());
        if (!key) {
            console.log(`  ${address}: ${amountText} USDT — no deposit-address key, skipped`);
            continue;
        }
        const gasPrice = ethers.utils.parseUnits(String(Math.max(Number(ethers.utils.formatUnits(await provider.getGasPrice(), 'gwei')) * 1.2, DEFAULT_GAS_GWEI).toFixed(2)), 'gwei');
        const signer = new ethers.Wallet(key, provider);
        const customerToken = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, signer);
        const tx = await customerToken.transfer(hotAddress, raw, { gasLimit: DEFAULT_GAS_LIMIT, gasPrice });
        await tx.wait(1);
        console.log(`  ${address}: swept ${amountText} USDT -> hot ${tx.hash}`);
        const db2 = await getDb();
        try {
            await recordEthMove(db2, HOT_USER_ID, '0', tx.hash, address,
                `Sweep USDT ${amountText} from deposit address (gas paid in ETH)`);
        } finally {
            await db2.end();
        }
    }
    console.log('Sweep done.');
}

async function cmdEthBalance(addressArg) {
    const { provider } = readOnly();
    const address = (addressArg || process.env.USDT_HOT_ADDRESS || '').trim();
    if (!address) throw new Error('no address given and USDT_HOT_ADDRESS not set');
    const raw = await provider.getBalance(address);
    console.log(`${address}: ${fmt(Number(raw) / 1e18)} ETH`);
}

async function cmdEthSendInternal(toAddress, amountWeiBigNumber) {
    const { wallet, provider } = hotWallet();
    const from = await wallet.getAddress();
    const gasPrice = ethers.utils.parseUnits(String(Math.max(Number(ethers.utils.formatUnits(await provider.getGasPrice(), 'gwei')) * 1.2, DEFAULT_GAS_GWEI).toFixed(2)), 'gwei');
    const balance = await provider.getBalance(from);
    const gas = ethers.BigNumber.from(21000);
    if (balance.lt(amountWeiBigNumber.add(gas.mul(gasPrice)))) {
        throw new Error(`hot wallet ETH too low for gas top-up: has ${ethers.utils.formatEther(balance)} ETH`);
    }
    const tx = await wallet.sendTransaction({ to: toAddress, value: amountWeiBigNumber, gasPrice, gasLimit: gas });
    await tx.wait(1);
    console.log(`[ETH] ${ethers.utils.formatEther(amountWeiBigNumber)} ETH ${from} -> ${toAddress}: ${tx.hash}`);
    const db = await getDb();
    try {
        await recordEthMove(db, HOT_USER_ID, ethers.utils.formatEther(amountWeiBigNumber), tx.hash, toAddress, 'ETH gas top-up for USDT sweep');
    } finally {
        await db.end();
    }
    return tx.hash;
}

async function cmdEthSend(toAddress, amountEth) {
    const v = validateAddress(toAddress);
    if (!v.isvalid) throw new Error(`invalid address: ${toAddress} (${v.reason})`);
    const wei = ethers.utils.parseEther(String(amountEth));
    return cmdEthSendInternal(v.address, wei);
}

// --- CLI --------------------------------------------------------------------

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    switch (cmd) {
        case 'balance': return cmdBalance();
        case 'validate': return cmdValidate(args[0] || '');
        case 'send':
            if (args.length < 2) { usage(); process.exit(1); }
            return cmdSend(args[0], args[1], args[2] || '0');
        case 'sweep': return cmdSweep(args[0]);
        case 'eth-balance': return cmdEthBalance(args[0]);
        case 'eth-send':
            if (args.length < 2) { usage(); process.exit(1); }
            return cmdEthSend(args[0], args[1]);
        default: usage();
    }
}

function usage() {
    console.log('USDT Withdrawal Tool (ERC-20, Ethereum mainnet, decimals 6)');
    console.log('Usage:');
    console.log('  node usdt-withdraw.js balance                        - hot wallet USDT + ETH');
    console.log('  node usdt-withdraw.js validate <address>             - validate recipient');
    console.log('  node usdt-withdraw.js send <address> <amount> [fee]  - withdraw USDT');
    console.log('  node usdt-withdraw.js sweep [min]                    - collect customer addresses into hot wallet');
    console.log('  node usdt-withdraw.js eth-balance [address]          - ETH (gas) balance');
    console.log('  node usdt-withdraw.js eth-send <to> <amountEth>      - send ETH for gas');
}

if (require.main === module) {
    main().catch(err => { console.error(err.message || err); process.exit(1); });
}

module.exports = { processWithdrawal: cmdSend, validateAddress, sweep: cmdSweep };
