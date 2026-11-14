# ForkEx

ForkEx — криптобиржевой движок на базе [HollaEx Kit](https://github.com/hollaex/hollaex-kit) (white label платформа: биржа, трейдинг, управление пользователями, кошельковая система). Форк развёрнут как самостоятельный узел с локальным матчингом ордеров, собственной инфраструктурой кошельков (LBTC, USDT/ERC-20, Solana SPL) и торговым ботом.

Первоисточник проекта (upstream):

```
git clone https://github.com/hollaex/hollaex-kit.git
```

## Состав

| Компонент | Каталог | Назначение |
|---|---|---|
| API (back-end) | `server/` | Kit API: аккаунты, балансы, ордера, выводы, настройки |
| Web (front-end) | `web/` | Пользовательский интерфейс биржи (React) |
| WebSocket | `ws/` | Реалтайм-фиды: ордербук, сделки, балансы |
| Plugins | `plugins/` | Хост плагинов Kit |
| Affiliation | `affiliation/` | Реферальная программа |
| Bot | `bot/` | Торговый бот на Go (маркет-мейкинг, внешние цены) |
| Price Oracle | `price-oracle/` | Источник цен и анкоринг для бота |
| Wallet Scanner | `wallet-scanner/` | Сканирование депозитов LBTC: журнал pending-холдов вместо прямого зачисления |
| Order Tracker | `order-tracker/` | Трекинг ордеров |
| State Anchor | `state-anchor/` | Анкоринг состояния |
| Market Maker | `market-maker/` | Маркет-мейкинг утилиты |

## Ключевые отличия от upstream

- **Локальный матчинг-движок** — кросс-исполнение ордеров при создании, атомарные транзакции, maker/taker комиссии (не требуется HollaEx Network для исполнения).
- **Кошельковая инфраструктура LBTC** (`server/scripts/`, `server/lib/lbtc-rpc.js`) — депозиты через wallet-scanner с холдами и зачислением после подтверждений, выводы через ноду, fee ledger и sweep депозитных адресов, синхронизация балансов с ledger, бэкфиллы.
- **USDT (ERC-20, Ethereum mainnet)** — монитор депозитов `check-usdt-deposits.js` (eth_getLogs, зачисление после 12 подтверждений с проверкой receipt и защитой от реоргов), выводы `usdt-withdraw.js`, генерация адресов, sweep. Документация: [`server/scripts/README-usdt.md`](server/scripts/README-usdt.md).
- **TRUMP (Solana SPL)** — поддержка генерации кошельков и отображения.
- **RBAC** — роль оператора наряду с администратором.
- **Комиссии на вывод по сетям** — per-network fee model, отображение полной суммы списания.
- **Управление как единый стек** — `up.sh` и `docker-compose.yaml` поднимают postgres, redis, api, plugins, websocket, affiliation, web, nginx, bot, price-oracle в сети `forkex-network`.

## Запуск

```
./up.sh
```

Скрипт останавливает старые контейнеры и поднимает стек через `docker compose -f docker-compose.yaml up -d`.

Конфигурация: `.env` (шаблон — `.env.example`), сетевые настройки nginx (`nginx/`), образы собираются через `Dockerfile*` в корне и каталогах компонентов.

## Разработка

- Web UI: `web/`
- Сервер и эндпоинты: `server/`
- Плагины Kit: `plugins/`
- Библиотеки HollaEx (network-lib, tools-lib): `server/utils/`
- Руководство по контрибьюции: [CONTRIBUTING.md](CONTRIBUTING.md)

## Полезные ссылки (upstream)

- Документация HollaEx: https://docs.hollaex.com
- HollaEx CLI: https://github.com/hollaex/hollaex-cli
- Форум: https://forum.hollaex.com
- Discord: https://discord.gg/RkRHU8RbyM
