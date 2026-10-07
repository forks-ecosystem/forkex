'use strict';

// Проекция строки `withdrawals` в форму ответа /user/withdrawals и разбор
// булевых query-параметров фильтра статуса.
//
// Модуль намеренно не импортирует db/models: логика чистая, без БД и без
// побочных подключений (sequelize при импорте тянет redis/pubsub-клиент), что
// позволяет тестировать её обычным mocha без поднятого окружения.
//
// Форма ответа зафиксирована фронтом
// (web/src/containers/TransactionsHistory):
//   - utils.js#generateWithdrawalsHeaders ждёт булевы status/dismissed/rejected/
//     processing/waiting, строковый type и transaction_id для ссылки в эксплорер;
//   - selectors.js#modifyDepositsAndWithdrawals делает coins[currency] ради
//     display_name/icon_id и coins[fee_coin || currency] ради fee_coin_display.
// Раньше ни форма, ни фильтры этому контракту не соответствовали.

// Статусы в таблице `withdrawals` и их проекция. Фронт оперирует булевыми
// полями, а не строкой из БД, поэтому проекция обязана быть исчерпывающей:
// любое нераспознанное значение молча превращается в «ожидает» и рисует
// пользователю вечную «Pending».
const WITHDRAWAL_STATUS = {
  completed: { status: true,  dismissed: false, rejected: false, processing: false, waiting: false },
  processing: { status: false, dismissed: false, rejected: false, processing: true,  waiting: false },
  // 'failed' — нода отказала, резерв возвращён: деньги у пользователя, это Rejected,
  // а не Pending. Иначе сумма висит в истории как незавершённая навсегда.
  failed:     { status: false, dismissed: true,  rejected: true,  processing: false, waiting: false },
  cancelled:  { status: false, dismissed: true,  rejected: true,  processing: false, waiting: false },
};

const DB_STATUSES = Object.keys(WITHDRAWAL_STATUS);

const mapStatus = (dbStatus) =>
  WITHDRAWAL_STATUS[dbStatus] || { status: false, dismissed: false, rejected: false, processing: false, waiting: true };

const formatWithdrawal = (w) => {
  const currency = (w.coin?.symbol || '').toLowerCase();
  const txHash = w.tx_hash || '';
  return {
    id: w.id,
    user_id: w.user_id,
    coin_id: w.coin_id,
    amount: parseFloat(w.amount),
    fee: w.fee ? parseFloat(w.fee) : 0,
    // currency обязателен: selectors.js делает coins[currency] и берёт оттуда
    // display_name/icon_id, а coins[fee_coin || currency] — для fee_coin_display.
    // Без этого поля колонки «Валюта» и «Комиссия» рисуют DEFAULT_COIN_DATA
    // вместо монеты.
    currency,
    // fee_coin_display — единица измерения в колонке FEE.
    fee_coin_display: currency.toUpperCase(),
    ...mapStatus(w.status),
    // type обязателен: ветка «Pending» во фронте показывает кнопку отмены
    // только для type === 'withdrawal'.
    type: 'withdrawal',
    // transaction_id — то, что фронт отдаёт в EXPLORERS_ENDPOINT и в уведомление.
    // Раньше это поле не возвращалось вовсе, поэтому ссылка «VIEW» вела в никуда.
    transaction_id: txHash,
    txid: txHash,
    tx_hash: txHash,
    address: w.address || '',
    network: currency,
    symbol: currency,
    coin_name: w.coin?.name || '',
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
};

// Приводит query-значение к boolean | undefined. Swagger объявляет эти параметры
// булевыми, но приходят они строками ('true'/'false'), а isBoolean в
// hollaex-network-lib пропускает только настоящие boolean — поэтому разбор
// терпим к обоим представлениям.
const asBoolean = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return undefined;
};

// Фильтр приходит булевыми query-параметрами, а колонка status в БД — строкой,
// поэтому булевы флаги переводятся обратно в набор строк таблицы: остаются те
// строки, чья проекция совпадает по всем переданным флагам. Сравнение строгое,
// поэтому нераспознанный статус (fallback в waiting) под фильтр молча не
// попадает.
const readStatusFlags = (query) => {
  const flags = {};
  for (const name of ['status', 'dismissed', 'rejected', 'processing', 'waiting']) {
    const value = asBoolean(query[name]);
    if (value !== undefined) flags[name] = value;
  }
  return flags;
};

const statusStringsMatching = (flags) =>
  DB_STATUSES.filter((dbStatus) =>
    Object.entries(flags).every(([flag, want]) => WITHDRAWAL_STATUS[dbStatus][flag] === want)
  );

module.exports = {
  WITHDRAWAL_STATUS,
  DB_STATUSES,
  mapStatus,
  formatWithdrawal,
  asBoolean,
  readStatusFlags,
  statusStringsMatching
};
