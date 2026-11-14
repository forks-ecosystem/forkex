'use strict';

// Fill in missing USDT deposit addresses.
//
// Old rows in user_wallets (currency 'usdt') were created before the
// ERC-20 address generator existed and have an empty address; a user without
// an address cannot receive deposits and does not appear in the monitor's
// watch list. The exchange API generates an address the moment the user opens
// the deposit page (POST /user/create-crypto-address → createUserCryptoAddressByKitId
// → wallets/generate.js case 'usdt'); this script does the same thing in bulk
// for the users who have not triggered it themselves, using the exact same
// generator (wallets/usdt-wallet.js, HD m/44'/60'/0'/0/0).
//
// Run (dry by default):
//   node usdt-gen-missing.js            - list users that would get an address
//   node usdt-gen-missing.js --apply    - generate and write
//
// Keys and mnemonics are NOT stored (same as the API flow): only the address
// lands in the exchange DB. The mnemonic is printed once to stdout — copy it
// into the wallet backup if you need to recover those funds.

const { dbConfig } = require('./usdt-lib');
const { generate } = require('../wallets/usdt-wallet');
const bip39 = require('bip39');

function main() {
    const apply = process.argv.includes('--apply');
    const { Client } = require('pg');
    const client = new Client({ ...dbConfig(), connectionTimeoutMillis: 5000 });

    client.connect()
        .then(() => client.query(
            `SELECT id, user_id FROM user_wallets
              WHERE currency = 'usdt' AND is_valid = true
                AND (address IS NULL OR address = '')`
        ))
        .then(async (res) => {
            console.log(`${res.rows.length} usdt wallet(s) without an address`);
            for (const row of res.rows) {
                const mnemonic = bip39.generateMnemonic();
                const wallet = generate(mnemonic);
                if (!apply) {
                    console.log(`  would generate: user_id=${row.user_id} wallet_id=${row.id} -> ${wallet.address}`);
                    continue;
                }
                await client.query(
                    `UPDATE user_wallets
                        SET address = $1::text, network = 'eth', updated_at = NOW()
                      WHERE id = $2::int`,
                    [wallet.address, row.id]
                );
                // users.crypto_wallet mirrors the address for the API/web,
                // exactly like createUserCryptoAddressByKitId does.
                await client.query(
                    `UPDATE users
                        SET crypto_wallet = COALESCE(crypto_wallet, '{}'::jsonb)
                            || jsonb_build_object('usdt',
                                jsonb_build_object('eth', $1::text))
                      WHERE id = $2::int`,
                    [wallet.address, row.user_id]
                );
                console.log(`  generated: user_id=${row.user_id} -> ${wallet.address}`);
                console.log(`  mnemonic (SAVE IT, printed once): ${mnemonic}`);
            }
            await client.end();
        })
        .catch((e) => {
            console.error(`Fatal: ${e.message}`);
            process.exit(1);
        });
}

main();
