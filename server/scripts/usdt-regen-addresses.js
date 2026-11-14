'use strict';

// ONE-OFF (2026-11-11): regenerate customer USDT deposit addresses with the
// FIXED usdt-wallet generator.
//
// Until today wallets/usdt-wallet.js hashed the COMPRESSED public key, so the
// addresses it produced are not controlled by their private keys — a deposit
// sent to such an address would be stranded. No deposits have happened yet
// (all usdt balances are 0), so every affected address is replaced now.
//
// Keys/mnemonics ARE saved this time (doc189: the exchange keeps keys for
// signing sweeps) — to /etc/lbtc-ops/wallet-backups/usdt-customer-keys-<ts>.json,
// mode 0600. The DB stores only the address, exactly like the API flow.
//
// Run:
//   node usdt-regen-addresses.js           (dry run)
//   node usdt-regen-addresses.js --apply

const fs = require('fs');
const bip39 = require('bip39');
const { ethers } = require('ethers');
const { dbConfig } = require('./usdt-lib');
const { generate } = require('../wallets/usdt-wallet');

const APPLY = process.argv.includes('--apply');
// Currency to regenerate. usdt by default; xht shares the same (fixed)
// usdt-wallet generator, so the stranded-address bug applies there too.
const CURRENCY = (process.argv.find(a => /^--currency=/.test(a)) || 'usdt').split('=')[1] || 'usdt';

async function main() {
    const { Client } = require('pg');
    const client = new Client({ ...dbConfig(), connectionTimeoutMillis: 5000 });
    await client.connect();

    const rows = (await client.query(
        `SELECT id, user_id, purpose, address FROM user_wallets
          WHERE currency = $1 AND is_valid = true
            AND address IS NOT NULL AND address <> ''
            AND LOWER(address) <> LOWER($2)
          ORDER BY id`,
        [CURRENCY, process.env.USDT_HOT_ADDRESS || '']
    )).rows;

    console.log(`${rows.length} ${CURRENCY} wallet row(s) with an address (hot wallet ${process.env.USDT_HOT_ADDRESS || '?'} excluded)`);
    const out = [];
    for (const r of rows) {
        const mnemonic = bip39.generateMnemonic();
        const w = generate(mnemonic);
        // ground truth: the key must derive to the address we are about to store
        const truth = new ethers.Wallet(w.privateKey).address.toLowerCase();
        if (truth !== w.address.toLowerCase()) {
            throw new Error(`generator still broken: ${w.address} != ${truth}`);
        }
        console.log(`  user_id=${r.user_id} wallet_id=${r.id} purpose=${r.purpose || '-'} ${r.address} -> ${w.address}`);
        out.push({ user_id: r.user_id, wallet_id: r.id, old_address: r.address, address: w.address, privateKey: w.privateKey, publicKey: w.publicKey, mnemonic });
        if (!APPLY) continue;
        await client.query(
            `UPDATE user_wallets
                SET address = $1::text, network = 'eth', updated_at = NOW()
              WHERE id = $2::int`,
            [w.address, r.id]
        );
        // Only customer rows (no purpose) mirror into users.crypto_wallet,
        // the same way createUserCryptoAddressByKitId does.
        if (!r.purpose) {
            await client.query(
                `UPDATE users
                    SET crypto_wallet = COALESCE(crypto_wallet, '{}'::jsonb)
                        || jsonb_build_object($1::text, jsonb_build_object('eth', $2::text))
                  WHERE id = $3::int`,
                [CURRENCY, w.address, r.user_id]
            );
        }
    }

    await client.end();

    if (APPLY) {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const file = `/etc/lbtc-ops/wallet-backups/${CURRENCY}-customer-keys-${stamp}.json`;
        fs.writeFileSync(file, JSON.stringify({ created: new Date().toISOString(), note: `${CURRENCY} deposit-address keys (fixed generator). Needed for sweeps. NEVER commit.`, wallets: out }, null, 2) + '\n');
        fs.chmodSync(file, 0o600);
        console.log(`applied; keys saved to ${file}`);
    } else {
        console.log('dry run — rerun with --apply');
    }
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
