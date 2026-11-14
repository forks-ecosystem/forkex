# USDT (ERC-20, Ethereum mainnet) — эксплуатационная документация

Настроено по описателям doc186–doc193. Модель повторяет проверенную LBTC-цепочку
(wallet-scanner → check-lbtc-deposits → lbtc-withdraw), адаптированную под
account-based ERC-20.

## Как это работает

```
               eth_getLogs (Transfer → наш адрес)
Ethereum ─────────────────────────────────────────────► check-usdt-deposits.js
(USDT contract                                     (systemd usdt-monitor.service,
 0xdAC17F…31ec7)                                    каждые 15 c)
                                                        │
                                                        ▼ journal (PENDING)
                                        usdt_deposit_holds / deposits / transactions
                                                        │
                                        ≥ 12 подтверждений (проверка по receipt)
                                                        ▼ CREDIT
                                        balances (+balance, +available)
                                        user_wallets (зеркало по адресу)
```

Ключевые факты, на которых всё держится:

| Факт | Почему важно |
|---|---|
| USDT — это **ERC-20**, баланс живёт в контракте, а не на адресе | Депозит виден только через `eth_getLogs`/`balanceOf`, нативный `eth_getBalance` его не видит (doc187) |
| **decimals = 6**, не 18 | Ошибка в 10^12 раз ломает все суммы (doc187) |
| Газ — **ETH**, никогда не USDT | Hot-кошелёк без ETH не может отправить ни вывод, ни sweep — `eth-balance`/`eth-send` для пополнения (doc186) |
| Свои RPC-запросы: `balanceOf` = `0x70a08231`, `Transfer` topic0 = `0xddf252ad…` | doc186 описывает построение вызовов вручную |

## Компоненты

| Файл | Роль |
|---|---|
| `scripts/usdt-lib.js` | Общий конфиг (env-цепочка usdt-ops.env → lbtc-ops.env → .env), JSON-RPC c fallback на архивный эндпоинт, конвертация 6-decimals |
| `scripts/check-usdt-deposits.js` | Монитор депозитов: getLogs → журнал pending → зачисление после 12 подтверждений → зеркала `user_wallets`. Сервис `usdt-monitor.service` |
| `scripts/usdt-withdraw.js` | Вывод USDT (ERC-20 `transfer()`), sweep депозитных адресов, управление ETH-газом |
| `scripts/usdt-gen-missing.js` | Дозаполнение пустых USDT-адресов (тот же генератор, что и API) |
| `/etc/lbtc-ops/usdt-ops.env` | Конфиг (0600): RPC, контракт, hot-кошелёк, ключ подписи |

## Что зачисляется, а что нет

- **Клиентский адрес** (`user_wallets.purpose` пустой) → депозит зачисляется
  пользователю после 12 подтверждений, проверенных по живому `eth_getTransactionReceipt`.
  Реорг (receipt исчез) → холд помечается `dropped`, транзакция `failed`, зачисления нет.
- **Адреса биржи** (hot/cold/fee/withdrawal/treasury/… ) → перевод ЖУРНАЛИРУЕТСЯ с
  `internal = true`, но НЕ зачисляется: это собственные средства биржи, уже
  учтённые при депозите клиента. Повторное зачисление свипов = двойной счёт.
- Дедупликация полная: `usdt_deposit_holds (deposit_tx, address, log_index)`
  + уникальные индексы `deposits (tx_hash, coin_id, address, amount)` и
  `transactions (tx_hash, currency, user_id, address, amount) WHERE type='deposit'`.

## Вывод USDT

```bash
cd /app/forkex/server
node scripts/usdt-withdraw.js balance                  # USDT + ETH (газ) + строка леджера
node scripts/usdt-withdraw.js validate <0x…>           # EIP-55 проверка получателя
node scripts/usdt-withdraw.js send <0x…> 100 [fee]     # вывод: broadcast + дебет леджера
node scripts/usdt-withdraw.js sweep [min]              # сбор депозитных адресов в hot
node scripts/usdt-withdraw.js eth-balance [addr]       # баланс ETH (газ)
node scripts/usdt-withdraw.js eth-send <to> <amountEth># пополнить газ
```

`send` сначала проверяет USDT-баланс и газ hot-кошелька (при нехватке газа
подсказывает команду пополнения), делает `estimateGas`, бродкастит, ждёт 1
подтверждение, и только потом дебетует `balances` (user 1) и пишет
`transactions` + `withdrawals`. Если бродкаст удался, а запись в БД нет —
печатается `!!! BROADCAST OK but LEDGER WRITE FAILED` для ручной сверки.

`sweep` двигается в два шага по адресу: сначала газ (если на адресе ETH меньше
нужного — он отправляется с hot-кошелька), на следующем запуске — перенос USDT.
Ключ клиента при свипе не нужен: ключи депозитных адресов у клиентов... см.
«Ограничение» ниже.

## Конфиг (/etc/lbtc-ops/usdt-ops.env)

| Переменная | Значение | Статус |
|---|---|---|
| `ETH_RPC_URL` | `https://ethereum-rpc.publicnode.com` | работает (недавнее окно) |
| `USDT_ARCHIVE_RPC_URL` | `https://eth.drpc.org` | fallback для глубокого catch-up |
| `USDT_CONTRACT` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | mainnet |
| `USDT_DECIMALS` | `6` | не менять |
| `USDT_COIN_ID` | `27` | id монеты в БД |
| `USDT_DEPOSIT_CONFIRMATIONS` | `12` | порог зачисления |
| `USDT_HOT_ADDRESS` | `0x0b6c49d4a579c8bdd3819bc196acf51babe4f5cd` | user 1, purpose=withdrawal — ключ восстановлен 2026-11-11 из API-ответа 2026-09-05, verified: key → address (ethers) |
| `USDT_HOT_PRIVATE_KEY` | заполнен | бэкап: `/etc/lbtc-ops/wallet-backups/usdt-hot-wallet-20261111.json` |
| `USDT_GAS_LIMIT` / `USDT_GAS_GWEI` | 120000 / 3 | дефолты газа |
| `USDT_SWEEP_MIN` | `10` | минимум USDT для свипа |

## Управление

```bash
systemctl status usdt-monitor          # журнал: journalctl -u usdt-monitor -f
systemctl restart usdt-monitor
```

Состояние сканера: `scripts/usdt-monitor-state.json` (lastScannedBlock).
Первая инициализация стартует с `latest - 17`, историю до запуска монитор не
сматривает принципиально.

## Что осталось сделать руками

1. ~~`USDT_HOT_PRIVATE_KEY`~~ — **готово**: ключ `0x0b6c49d4…` найден владельцем
   (API-ответ 2026-09-05), проверен (key → address, ethers + keccak pubkey),
   подключён в env, БД (строка 248 снова active) и бэкап.
2. **Пополнить hot-кошелёк ETH (~0.02–0.05 ETH)** — газ для выводов и свипов:
   `node scripts/usdt-withdraw.js eth-send 0x0b6c49d4… 0.02`.
3. Первую фактическую попытку депозита/вывода провести на малой сумме и
   сверить `balances` ↔ on-chain.

## Важно: генератор usdt-wallet.js был исправлен 2026-11-11

До фикса генератор хешировал **сжатый** публичный ключ (33 байта), а EVM-адрес
считается от несжатого (64 байта координат). Адреса, выданные до фикса
(все клиентские USDT-кошельки из `wallets/generate.js`), не соответствуют
своим ключам — депозит на такой адрес зависнет. Все клиентские USDT-адреса
перевыпущены после фикса; при выводе с hot-кошелька проблемы нет — он создан
правильным генератором (ethers). Новые адреса после фикса корректны.

### Конвенция на будущее: несжатые ключи (стандарт EVM)

Все EVM-генераторы биржи обязаны выдавать адрес, который
1. выводится из собственного privateKey (`ethers.Wallet(pk).address`),
2. детерминированно выводится из мнемоники по BIP44 (`m/44'/60'/0'/0/0`),
3. с несжатым publicKey (`0x04…`, 65 байт) — не сжатым (33 байта).

Это закреплено регрессионным тестом `test/evmAddressGenerators.test.js`
(usdt-wallet + eth-wallet). Добавляя новый EVM-генератор — включите его туда же.
`eth-wallet.js` тоже переписан: multichain-crypto-wallet игнорировал мнемонику
(вызывал `ethers.Wallet.createRandom()` — doc188 про это предупреждал); старые
ETH-адреса валидны (адрес = вывод ключа), но не были детерминированы от
мнемоники — оставлены как есть (балансы нулевые), новые будут BIP44.
XHT-адреса (тот же usdt-wallet до фикса) также перевыпущены:
`/etc/lbtc-ops/wallet-backups/xht-customer-keys-20261111.json`.

## Ограничение: свип клиентских адресов

`sweep` перемещает USDT с клиентского депозитного адреса, подписывая транзакцию
ключом ЭТОГО адреса. Ключи клиентских адресов не хранятся на бирже (как и у
LBTC, где адреса принадлежат ноде-кошельку). Пока ключи клиентских USDT-адресов
не консолидированы, свип их не найдёт по ключу — `sweep` работает только там,
где ключ известен (hot-кошелёк). Это не блокирует торговлю: зачисление идёт
напрямую, а «флот» для выводов — hot-кошелёк, который пополняется снаружи.
Для полноценного свипа клиентских адресов нужно хранить их ключи
(зашифрованно) или выпускать депозитные адреса из одной мастер-мнемоники —
отдельная задача (см. doc188 о HD-схеме).
