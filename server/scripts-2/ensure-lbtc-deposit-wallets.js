#!/usr/bin/env node
'use strict';

// Ensure every user has an LBTC deposit address in user_wallets.
//
// New addresses are derived in the node-owned `users` wallet (the key never
// leaves the node) and stored with purpose='deposit', matching the first
// server. Users that already have an active deposit wallet are skipped, so the
// script is idempotent.
//
// Existing default LBTC wallets (purpose IS NULL / '') are converted to
// purpose='deposit' instead of generating a second address: their balance and
// node key stay untouched.
//
// Usage (from /app/forkex/server):
//   node scripts/ensure-lbtc-deposit-wallets.js            # dry run
//   node scripts/ensure-lbtc-deposit-wallets.js --apply    # write
//   node scripts/ensure-lbtc-deposit-wallets.js --apply --users=57,100,101

const http = require('http');
const { dbConfig } = require('./lbtc-ops-env');

const APPLY = process.argv.includes('--apply');
const usersArg = process.argv.find((a) => a.startsWith('--users='));
const ONLY_USERS = usersArg
    ? usersArg.slice('--users='.length).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
    : null;

const CURRENCY = 'lbtc';
const NETWORK = 'lbtc';
const PURPOSE = 'deposit';
const BOT_ACTOR_HASH = 'ForkEX-BOT';

const AGENT_HOST = process.env.LBTC_AGENT_HOST || '127.0.0.1';
const AGENT_PORT = Number(process.env.LBTC_AGENT_PORT || 8444);
const AGENT_KEY = process.env.LBTC_AGENT_API_KEY || '';
const USER_WALLET = process.env.LBTC_USER_WALLET || 'users';

function agentPost(path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request({
            hostname: AGENT_HOST,
            port: AGENT_PORT,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': AGENT_KEY,
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 30000
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json;
                try { json = JSON.parse(data); }
                catch (e) { return reject(new Error(`agent: unparsable reply: ${data.slice(0, 200)}`)); }
                if (json.error) return reject(new Error(`agent: ${json.error}`));
                resolve(json.result !== undefined ? json.result : json);
            });
        });
        req.on('timeout', () => req.destroy(new Error('agent timeout')));
        req.on('error', reject);
        req.end(payload);
    });
}

async function newAddress() {
    const res = await agentPost(`/api/wallet/${encodeURIComponent(USER_WALLET)}/newaddress`, {});
    const address = res && (res.address !== undefined ? res.address : res);
    if (typeof address !== 'string' || !address) {
        throw new Error(`agent returned no address: ${JSON.stringify(res).slice(0, 200)}`);
    }
    return address;
}

async function main() {
    if (!AGENT_KEY) throw new Error('LBTC_AGENT_API_KEY не задан');

    const { Client } = require('pg');
    const db = new Client({ ...dbConfig(), connectionTimeoutMillis: 10000 });
    await db.connect();

    try {
        const params = [CURRENCY, PURPOSE];
        let filter = '';
        if (ONLY_USERS) {
            params.push(ONLY_USERS);
            filter = `AND u.id = ANY($${params.length}::int[])`;
        }

        const { rows } = await db.query(
            `SELECT u.id, u.email, u.role,
                    EXISTS (
                        SELECT 1 FROM user_wallets w
                         WHERE w.user_id = u.id AND w.currency = $1
                           AND w.purpose = $2 AND w.status = 'active'
                           AND w.address IS NOT NULL AND w.address <> ''
                    ) AS has_deposit,
                    (
                        SELECT w.address FROM user_wallets w
                         WHERE w.user_id = u.id AND w.currency = $1
                           AND (w.purpose IS NULL OR w.purpose = '')
                           AND w.status = 'active'
                         ORDER BY w.id LIMIT 1
                    ) AS default_address
               FROM users u
              WHERE true ${filter}
              ORDER BY u.id`,
            params
        );

        let created = 0;
        let converted = 0;
        let skipped = 0;
        let failed = 0;

        for (const user of rows) {
            if (user.has_deposit) {
                skipped++;
                console.log(`skip  ${user.id} ${user.email}: уже есть deposit`);
                continue;
            }

            if (user.default_address) {
                console.log(`${APPLY ? 'use  ' : 'plan '}${user.id} ${user.email}: ${user.default_address} -> purpose=${PURPOSE}`);
                if (APPLY) {
                    await db.query(
                        `UPDATE user_wallets
                            SET purpose = $2, actor_hash = COALESCE(NULLIF(actor_hash, ''), $3),
                                updated_at = NOW()
                          WHERE user_id = $1 AND currency = $4
                            AND (purpose IS NULL OR purpose = '')
                            AND status = 'active'`,
                        [user.id, PURPOSE, user.role === 'bot' ? BOT_ACTOR_HASH : null, CURRENCY]
                    );
                    await db.query(
                        `UPDATE users
                            SET crypto_wallet = jsonb_set(COALESCE(crypto_wallet, '{}'::jsonb), '{lbtc,lbtc}', to_jsonb($2::text), true),
                                updated_at = NOW()
                          WHERE id = $1`,
                        [user.id, user.default_address]
                    );
                    converted++;
                }
                continue;
            }

            if (!APPLY) {
                console.log(`plan  ${user.id} ${user.email}: новый ${NETWORK} адрес, purpose=${PURPOSE}`);
                continue;
            }

            let address;
            try {
                address = await newAddress();
            } catch (e) {
                failed++;
                console.error(`fail  ${user.id} ${user.email}: ${e.message}`);
                continue;
            }

            const client = await db.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    `INSERT INTO user_wallets
                        (user_id, currency, balance, available, address, network,
                         is_valid, purpose, actor_hash, status, created_at, updated_at)
                     VALUES ($1, $2, 0, 0, $3, $4, true, $5, $6, 'active', NOW(), NOW())`,
                    [user.id, CURRENCY, address, NETWORK, PURPOSE, user.role === 'bot' ? BOT_ACTOR_HASH : null]
                );
                await client.query(
                    `UPDATE users
                        SET crypto_wallet = jsonb_set(COALESCE(crypto_wallet, '{}'::jsonb), '{lbtc,lbtc}', to_jsonb($2::text), true),
                            updated_at = NOW()
                      WHERE id = $1`,
                    [user.id, address]
                );
                await client.query('COMMIT');
                created++;
                console.log(`ok    ${user.id} ${user.email}: ${address}`);
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                failed++;
                console.error(`fail  ${user.id} ${user.email}: ${e.message} (address ${address})`);
            } finally {
                client.release();
            }
        }

        console.log(`\n${APPLY ? 'done' : 'dry run'}: created=${created} converted=${converted} skipped=${skipped} failed=${failed}`);
    } finally {
        await db.end();
    }
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
