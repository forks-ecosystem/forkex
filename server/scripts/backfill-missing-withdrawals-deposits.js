'use strict';

// Разовая операция. Восстанавливает записи в `withdrawals` и `deposits` для
// завершённых on-chain транзакций, которые существуют в `transactions`, но по
// которым не была создана запись в соответствующей таблице.
//
// Причина пропусков: до патча server/utils/hollaex-tools-lib/tools/wallet.js
// выполнял только UPDATE balances + INSERT INTO transactions, а wallet-scanner
// вставлял в `deposits` лишь часть найденных попаданий. Таблица `withdrawals`
// вообще не заполнялась, поэтому:
//   - /user/withdrawals возвращал пустоту, и вывод не появлялся в истории;
//   - fx_withdrawal_guard (BEFORE INSERT ON withdrawals) не срабатывал ни разу —
//     лимиты single/monthly/KYC и проверка покрытия открытых ордеров были
//     полностью обойдены.
//
// Скрипт НЕ трогает balances, available и user_wallets: деньги уже списаны
// существующим путём, повторное движение средств задвоило бы учёт.
//
// Запуск (по умолчанию — только отчёт, ничего не пишет):
//   node scripts/backfill-missing-withdrawals-deposits.js --dry-run
//   node scripts/backfill-missing-withdrawals-deposits.js --apply
//
// Идемпотентен: повторный запуск не создаёт дубликаты (NOT EXISTS по tx_hash).

const { Client } = require('pg');

const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USERNAME || 'admin',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'hollaex',
};

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const MISSING_WITHDRAWALS = `
  SELECT t.id AS transaction_id, t.user_id, c.id AS coin_id, c.symbol,
         t.amount, t.fee, t.address, t.tx_hash, t.created_at
    FROM transactions t
    JOIN coins c ON c.symbol = t.currency
   WHERE t.type = 'withdrawal'
     AND t.status = 'completed'
     AND t.tx_hash IS NOT NULL
     AND t.currency IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.tx_hash = t.tx_hash)
   ORDER BY t.id`;

const MISSING_DEPOSITS = `
  SELECT t.id AS transaction_id, t.user_id, c.id AS coin_id, c.symbol,
         t.amount, t.fee, t.address, t.tx_hash, t.created_at
    FROM transactions t
    JOIN coins c ON c.symbol = t.currency
   WHERE t.type = 'deposit'
     AND t.status = 'completed'
     AND t.tx_hash IS NOT NULL
     AND t.currency IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.tx_hash = t.tx_hash)
   ORDER BY t.id`;

const insertWithdrawal = `
  INSERT INTO withdrawals (user_id, coin_id, amount, fee, status, address, tx_hash, created_at, updated_at)
  VALUES ($1::int, $2::int, $3::numeric, $4::numeric, 'completed', $5, $6, $7, $7)
  RETURNING id`;

const insertDeposit = `
  INSERT INTO deposits (user_id, coin_id, amount, fee, status, address, tx_hash, created_at, updated_at)
  VALUES ($1::int, $2::int, $3::numeric, $4::numeric, 'completed', $5, $6, $7, $7)
  RETURNING id`;

const main = async () => {
  const db = new Client(DB);
  await db.connect();
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`=== backfill [${mode}] ===`);

  let withdrawn = 0;
  let deposited = 0;
  try {
    if (ONLY !== 'deposits') {
      const { rows } = await db.query(MISSING_WITHDRAWALS);
      console.log(`\nwithdrawals: ${rows.length} missing`);
      for (const r of rows) {
        // created_at берётся из transactions: иначе бэкфилл отсортировался бы в
        // конец истории и пользователь увидел бы вывод не с той даты.
        if (APPLY) {
          // fx.gate выключается локально на время вставки: guard сверяет сумму с
          // balances.available, а баланс уже списан (вычитание произошло в момент
          // реальной выдачи). Проверять лимит по состоянию «после выдачи»
          // некорректно — повторного списания здесь не происходит. Для новых
          // выводов gate остаётся включённым (см. performWithdrawal).
          await db.query("BEGIN; SET LOCAL fx.gate = 'off'");
          try {
            const ins = await db.query(insertWithdrawal, [
              r.user_id, r.coin_id, r.amount, r.fee || 0, r.address, r.tx_hash, r.created_at,
            ]);
            await db.query('COMMIT');
            console.log(`  + withdrawals #${ins.rows[0].id}  tx=${r.transaction_id} user=${r.user_id} ${r.amount} ${r.symbol} ${r.tx_hash.slice(0, 16)}…`);
          } catch (e) {
            await db.query('ROLLBACK');
            throw e;
          }
        } else {
          console.log(`  ? tx=${r.transaction_id} user=${r.user_id} amount=${r.amount} fee=${r.fee} ${r.symbol} addr=${r.address} tx_hash=${r.tx_hash}`);
        }
        withdrawn += 1;
      }
    }

    if (ONLY !== 'withdrawals') {
      const { rows } = await db.query(MISSING_DEPOSITS);
      console.log(`\ndeposits: ${rows.length} missing`);
      for (const r of rows) {
        if (APPLY) {
          await db.query('BEGIN');
          try {
            const ins = await db.query(insertDeposit, [
              r.user_id, r.coin_id, r.amount, r.fee || 0, r.address, r.tx_hash, r.created_at,
            ]);
            await db.query('COMMIT');
            console.log(`  + deposits #${ins.rows[0].id}  tx=${r.transaction_id} user=${r.user_id} ${r.amount} ${r.symbol} ${r.tx_hash.slice(0, 16)}…`);
          } catch (e) {
            await db.query('ROLLBACK');
            throw e;
          }
        } else {
          console.log(`  ? tx=${r.transaction_id} user=${r.user_id} amount=${r.amount} ${r.symbol} addr=${r.address} tx_hash=${r.tx_hash}`);
        }
        deposited += 1;
      }
    }
  } finally {
    await db.end();
  }

  console.log(`\n=== ${APPLY ? 'applied' : 'would apply'}: ${withdrawn} withdrawal(s), ${deposited} deposit(s) ===`);
  if (!APPLY && (withdrawn || deposited)) {
    console.log('Re-run with --apply to write. Balances are NOT touched by this script.');
  }
};

main().catch((e) => {
  console.error('backfill failed:', e.message);
  process.exit(1);
});
