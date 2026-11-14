#!/usr/bin/env bash
# ============================================================================
# migrate-usdt.sh — ранбук переноса USDT (ERC-20) сервиса на второй сервер.
#
# Что переносится одной связкой (bundle):
#   - server/scripts/usdt-*.js + README-usdt.md + usdt-monitor-state.json (курсор)
#   - server/wallets/usdt-wallet.js (нужен usdt-gen-missing/usdt-regen-addresses)
#   - /etc/lbtc-ops/usdt-ops.env + lbtc-ops.env (0600, ключ hot-кошелька)
#   - /app/forkex/.env (последний фолбэк цепочки usdt-lib.js)
#   - /etc/systemd/system/usdt-monitor.service
#   - дамп kit-БД (pg_dump -Fc)
#   - manifest.env (инварианты: курсор, MAX(block_number) holds, sha256)
#
# node_modules НЕ входит в bundle (тяжёлый): переносится rsync'ом с источника.
# ВАЖНО: ethers (5.8.0) требуется usdt-withdraw.js, но ОТСУТСТВУЕТ в
# server/package.json — `npm ci` на приёмнике его снесёт. Поэтому node_modules
# копируется как есть, а не пересобирается.
#
# Инварианты (проверяются автоматически):
#   I1  один активный монитор на одну БД: на источнике сервис stop+disable ДО дампа;
#   I2  курсор и БД — одна связка: дамп снимается ТОЛЬКО после остановки монитора,
#       state-файл кладётся в bundle тем же запуском, на приёмнике курсор
#       сверяется с manifest.env (lastScannedBlock > 0 обязателен: при 0 монитор
#       инициализируется "latest-12-5" и молча пропустит депозиты);
#   I3  MAX(block_number) в usdt_deposit_holds <= lastScannedBlock (курсор покрывает
#       всё записанное; обратное = дамп снят посреди записи / перепутаны связки);
#   I4  повтор сканирования безопасен: уникальный индекс
#       (deposit_tx, address, log_index) + ON CONFLICT DO NOTHING;
#   I5  зависимости на приёмнике: node >= 22 (встроенный fetch), pg/ethers/bip39
#       в server/node_modules (NODE_PATH из юнита);
#   I6  конфиг: USDT_HOT_ADDRESS, USDT_HOT_PRIVATE_KEY, ETH_RPC_URL; доступность
#       chain RPC и ненулевой ETH-баланс hot-кошелька (газ платится в ETH);
#   I7  hot-кошелёк ОДИН на оба сервера: usdt-withdraw.js запускать только на
#       одном хосте за раз (конфликт nonce).
#
# Использование:
#   migrate-usdt.sh source [user@host]      # источник: стоп монитора -> дамп -> bundle -> (перенос)
#   migrate-usdt.sh dest <bundle.tar.gz> [--start]   # приёмник: восстановление -> проверки -> тест once -> (запуск)
#   migrate-usdt.sh verify                  # только проверки инвариантов на текущем хосте (read-only)
#   migrate-usdt.sh help
#
# Откат на источнике: systemctl enable --now usdt-monitor.service
# ============================================================================
set -euo pipefail

SCRIPTS_DIR="/app/forkex/server/scripts"
WALLETS_DIR="/app/forkex/server/wallets"
SERVER_DIR="/app/forkex/server"
KIT_ENV="/app/forkex/.env"
OPS_DIR="/etc/lbtc-ops"
UNIT="usdt-monitor.service"
UNIT_PATH="/etc/systemd/system/$UNIT"
STATE_FILE="$SCRIPTS_DIR/usdt-monitor-state.json"
MONITOR_JS="check-usdt-deposits.js"

USDT_FILES=(usdt-lib.js check-usdt-deposits.js usdt-withdraw.js usdt-gen-missing.js usdt-regen-addresses.js usdt-monitor-state.json README-usdt.md)

log()  { echo "[$(date '+%F %T')] $*"; }
warn() { echo "ПРЕДУПРЕЖДЕНИЕ: $*" >&2; }
die()  { echo "ОШИБКА: $*" >&2; exit 1; }

# --- цепочка env (повторяет usdt-lib.js: первый источник выигрывает) --------
load_env_file() {
    [ -f "$1" ] || return 0
    local line key val
    while IFS= read -r line; do
        line="${line%$'\r'}"
        line="${line#"${line%%[![:space:]]*}"}"          # trim left
        [ -z "$line" ] && continue
        case "$line" in \#*|\;*) continue ;; esac
        line="${line#export }"
        key="${line%%=*}"; [ "$key" = "$line" ] && continue
        val="${line#*=}"
        val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
        if [ -z "${!key+x}" ]; then export "$key=$val"; fi
    done < "$1"
}

load_env_chain() {
    [ -n "${USDT_OPS_ENV_FILE:-}" ] && load_env_file "$USDT_OPS_ENV_FILE"
    load_env_file "$OPS_DIR/usdt-ops.env"
    load_env_file "$OPS_DIR/lbtc-ops.env"
    load_env_file "$KIT_ENV"
}

db_vars() {
    DB_HOST="${USDT_DB_HOST:-${LBTC_DB_HOST:-${DB_HOST:-127.0.0.1}}}"
    DB_PORT="${USDT_DB_PORT:-${LBTC_DB_PORT:-${DB_PORT:-5434}}}"
    DB_NAME="${USDT_DB_NAME:-${LBTC_DB_NAME:-${DB_NAME:-hollaex}}}"
    DB_USER="${USDT_DB_USER:-${LBTC_DB_USER:-${DB_USERNAME:-}}}"
    DB_PASSWORD="${USDT_DB_PASSWORD:-${LBTC_DB_PASSWORD:-${DB_PASSWORD:-}}}"
    [ -n "$DB_USER" ] || die "DB_USER не разрешён из цепочки env (USDT_DB_*/LBTC_DB_*/DB_USERNAME)"
    [ -n "$DB_PASSWORD" ] || warn "DB_PASSWORD пуст — если БД требует пароль, дамп/psql упадут"
}

psql_db() { PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"; }
db_scalar() { psql_db -Atqc "$1" 2>/dev/null || true; }

# --- инвариант I3: курсор покрывает всё, что уже записано в holds -----------
holds_max_block() {
    db_scalar "SELECT COALESCE(MAX(block_number), 0) FROM $(psql_db -Atqc \
        "SELECT 'usdt_deposit_holds' WHERE to_regclass('public.usdt_deposit_holds') IS NOT NULL" \
        | head -n1 || true)"
}

cursor_value() {
    [ -f "$STATE_FILE" ] || { echo 0; return; }
    node -e "try{console.log(Number(require('$STATE_FILE').lastScannedBlock||0))}catch(e){console.log(0)}" 2>/dev/null \
        || sed -n 's/.*"lastScannedBlock"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$STATE_FILE" | head -n1 \
        || echo 0
}

deps_ok() {
    local miss=0 m
    for m in pg ethers bip39; do
        [ -d "$SERVER_DIR/node_modules/$m" ] || { warn "нет $SERVER_DIR/node_modules/$m"; miss=1; }
    done
    return $miss
}

node_bin() {
    if [ -n "${NODE_BIN:-}" ]; then echo "$NODE_BIN"; return; fi
    local n
    n="$(command -v node 2>/dev/null || true)"
    if [ -z "$n" ]; then
        n="$(ls -1 /root/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n1 || true)"
    fi
    echo "${n:-}"
}

# --- verify: инварианты I2..I6 на текущем хосте (read-only) -----------------
cmd_verify() {
    local fail=0 cursor holds node_v

    load_env_chain
    for v in USDT_HOT_ADDRESS USDT_HOT_PRIVATE_KEY ETH_RPC_URL; do
        [ -n "${!v:-}" ] || { warn "$v не задан ($OPS_DIR/usdt-ops.env)"; fail=1; }
    done

    [ -f "$STATE_FILE" ] || { warn "нет state-файла $STATE_FILE"; fail=1; }
    cursor="$(cursor_value)"
    if [ "${cursor:-0}" -le 0 ]; then
        warn "курсор lastScannedBlock=$cursor (0 => при старте монитор прыгнет на latest-12-5 и ПРОПУСТИТ депозиты)"
        fail=1
    else
        log "курсор lastScannedBlock=$cursor"
    fi

    if ! deps_ok; then
        warn "зависимости node_modules неполны (нужны pg, ethers, bip39); ethers в package.json ОТСУТСТВУЕТ — переносить rsync'ом"
        fail=1
    fi

    node_v="$(node_bin)"
    if [ -z "$node_v" ]; then warn "node не найден (PATH или /root/.nvm/versions/node/*/bin)"; fail=1;
    else
        local major; major="$("$node_v" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
        if [ "$major" -lt 22 ]; then warn "node $major < 22"; fail=1; else log "node: $node_v (v$major)"; fi
    fi

    db_vars
    if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null; then
        warn "postgres недоступен: $DB_HOST:$DB_PORT"; fail=1
    else
        local usdt_dep holds_max
        usdt_dep="$(db_scalar "SELECT COUNT(*) FROM deposits WHERE coin_id = ${USDT_COIN_ID:-27}::int")"
        holds="$(holds_max_block)"
        log "БД $DB_NAME: депозитов USDT (coin_id=${USDT_COIN_ID:-27}) = ${usdt_dep:-?}, MAX(block_number) holds = ${holds:-?}"
        if [ "${cursor:-0}" -gt 0 ] && [ "${holds:-0}" -gt "$cursor" ]; then
            warn "инвариант I3 НАРУШЕН: MAX(holds)=$holds > курсор=$cursor — дамп/связка рассинхронизированы"
            fail=1
        fi
    fi

    if [ -n "${ETH_RPC_URL:-}" ]; then
        local blk
        blk="$(curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
            --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$ETH_RPC_URL" \
            | sed -n 's/.*"result"[[:space:]]*:[[:space:]]*"\(0x[0-9a-fA-F]*\)".*/\1/p' || true)"
        if [ -n "$blk" ]; then
            log "chain RPC ok, head=0x${blk#0x}"
            if [ -n "${USDT_HOT_ADDRESS:-}" ]; then
                local bal_hex bal_eth
                bal_hex="$(curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
                    --data "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_getBalance\",\"params\":[\"$USDT_HOT_ADDRESS\",\"latest\"]}" \
                    "$ETH_RPC_URL" | sed -n 's/.*"result"[[:space:]]*:[[:space:]]*"\(0x[0-9a-fA-F]*\)".*/\1/p' || true)"
                if [ -n "$bal_hex" ]; then
                    bal_eth="$("$node_v" -e "console.log((Number(0x${bal_hex#0x}n)/1e18).toFixed(4))" 2>/dev/null || echo '?')"
                    log "hot-кошелёк $USDT_HOT_ADDRESS: ETH ${bal_eth} (газ)"
                    if [ "$bal_eth" != "?" ] && awk "BEGIN{exit !($bal_eth < 0.0005)}"; then
                        warn "ETH-баланс hot-кошелька < 0.0005 — выводы и sweep упадут без газа"
                        fail=1
                    fi
                fi
            fi
        else
            warn "chain RPC $ETH_RPC_URL не отвечает"; fail=1
        fi
    fi

    if systemctl list-unit-files 2>/dev/null | grep -q "^$UNIT"; then
        log "юнит $UNIT: $(systemctl is-enabled "$UNIT" 2>/dev/null || echo disabled) / $(systemctl is-active "$UNIT" 2>/dev/null || echo inactive)"
    else
        warn "юнит $UNIT не установлен"
        [ "$1" = "dest" ] && fail=1
    fi

    if [ "$fail" = "0" ]; then log "проверки пройдены"; else warn "есть проваленные проверки (см. выше)"; return 1; fi
}

# --- source: стоп монитора -> дамп -> bundle -> (перенос) --------------------
cmd_source() {
    local dest_host="${1:-}"
    local bundle="/root/forkex-usdt-migrate-$(date +%Y%m%d-%H%M%S).tar.gz"
    local stage; stage="$(mktemp -d /tmp/forkex-usdt-migrate.XXXXXX)"

    # --- preflight
    for f in "$USDT_FILES[@]"; do [ -f "$SCRIPTS_DIR/$f" ] || die "нет $SCRIPTS_DIR/$f"; done
    [ -f "$WALLETS_DIR/usdt-wallet.js" ] || die "нет $WALLETS_DIR/usdt-wallet.js"
    [ -f "$UNIT_PATH" ] || die "нет $UNIT_PATH"
    [ -d "$SERVER_DIR/node_modules/pg" ] || die "нет $SERVER_DIR/node_modules — перенесите серверные зависимости"
    load_env_chain; db_vars
    for f in "$OPS_DIR/usdt-ops.env" "$OPS_DIR/lbtc-ops.env"; do
        [ -f "$f" ] || die "нет конфига $f (в bundle попадает как есть, права 0600)"
    done

    # --- I1: остановить и ОТКЛЮЧИТЬ монитор ДО дампа (I2)
    if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
        log "останавливаю $UNIT (rollback: systemctl enable --now $UNIT)"
        systemctl stop "$UNIT"
        systemctl disable "$UNIT" >/dev/null 2>&1 || true
    else
        log "$UNIT уже неактивен (enabled=$(systemctl is-enabled "$UNIT" 2>/dev/null || echo disabled))"
        systemctl disable "$UNIT" >/dev/null 2>&1 || true
    fi
    for i in 1 2 3 4 5; do pgrep -f "$MONITOR_JS" >/dev/null || break; sleep 1; done
    pgrep -f "$MONITOR_JS" >/dev/null && die "процесс $MONITOR_JS ещё жив — дамп откладывать нельзя, разберитесь вручную"

    # --- I2/I3: курсор должен существовать и покрывать holds
    local cursor holds
    cursor="$(cursor_value)"
    [ "$cursor" -gt 0 ] || die "курсор lastScannedBlock=$cursor — НЕ переносите такую связку (на приёмнике монитору придётся стартовать с latest-12-5 и он пропустит депозиты)"
    holds="$(holds_max_block)"
    [ "${holds:-0}" -le "$cursor" ] || die "инвариант I3: MAX(holds)=$holds > курсор=$cursor"
    log "курсор=$cursor, MAX(holds)=$holds — связка консистентна, снимаю дамп"

    # --- дамп БД
    command -v pg_dump >/dev/null || die "нет pg_dump (apt install postgresql-client)"
    local dump="$stage/kit-db.dump"
    PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -Fc \
        -f "$dump" "$DB_NAME" || die "pg_dump упал"
    log "дамп $DB_NAME готов ($(du -h "$dump" | cut -f1))"

    # --- manifest.env (парсится на приёмнике)
    local dsha state_sha
    dsha="$(sha256sum "$dump" | awk '{print $1}')"
    state_sha="$(sha256sum "$STATE_FILE" | awk '{print $1}')"
    local usdt_dep
    usdt_dep="$(db_scalar "SELECT COUNT(*) FROM deposits WHERE coin_id = ${USDT_COIN_ID:-27}::int")"
    cat > "$stage/manifest.env" <<EOF
created_at=$(date '+%F %T')
source_host=$(hostname)
db_name=$DB_NAME
db_host=$DB_HOST
db_port=$DB_PORT
usdt_coin_id=${USDT_COIN_ID:-27}
usdt_contract=${USDT_CONTRACT:-0xdAC17F958D2ee523a2206206994597C13D831ec7}
last_scanned_block=$cursor
holds_max_block=${holds:-0}
deposits_usdt_count=${usdt_dep:-0}
dump_sha256=$dsha
state_sha256=$state_sha
EOF

    # --- сборка bundle (пути внутри tar — без ведущего /)
    local root="$stage/root"
    mkdir -p "$root/app/forkex/server/scripts" "$root/app/forkex/server/wallets" \
             "$root/etc/lbtc-ops" "$root/etc/systemd/system" "$root/opt/forkex-usdt-migrate"
    cp "$SCRIPTS_DIR/${USDT_FILES[@]}" "$root/app/forkex/server/scripts/"
    cp "$WALLETS_DIR/usdt-wallet.js" "$root/app/forkex/server/wallets/"
    [ -f "$KIT_ENV" ] && cp "$KIT_ENV" "$root/app/forkex/.env"
    cp "$OPS_DIR/usdt-ops.env" "$OPS_DIR/lbtc-ops.env" "$root/etc/lbtc-ops/"
    cp "$UNIT_PATH" "$root/etc/systemd/system/"
    cp "$dump" "$stage/manifest.env" "$root/opt/forkex-usdt-migrate/"
    chmod 600 "$root/etc/lbtc-ops/"* "$root/app/forkex/.env" 2>/dev/null || true

    ( cd "$stage/root" && tar -czf "$bundle" app etc opt )
    chmod 600 "$bundle"
    rm -rf "$stage"
    log "bundle готов: $bundle ($(du -h "$bundle" | cut -f1))"
    warn "в bundle лежат секреты (ключ hot-кошелька). Передавайте только по scp/ssh, удалите на приёмнике после установки: rm $bundle"

    # --- перенос
    if [ -n "$dest_host" ]; then
        log "переношу bundle -> $dest_host:/root/"
        scp -p "$bundle" "$dest_host:/root/"
        log "rsync server/node_modules (нужен pg/ethers/bip39; ethers нет в package.json — не пересобирать через npm ci)"
        rsync -a "$SERVER_DIR/node_modules/" "$dest_host:$SERVER_DIR/node_modules/"
        log "на приёмнике: migrate-usdt.sh dest /root/$(basename "$bundle")"
    else
        log "вручную: scp -p $bundle <user@host>:/root/  и  rsync -a $SERVER_DIR/node_modules/ <user@host>:$SERVER_DIR/node_modules/"
    fi
    log "rollback на источнике после отказа от переезда: systemctl enable --now $UNIT"
}

# --- dest: восстановление -> проверки -> тест once -> (--start) --------------
as_postgres() {
    if id postgres >/dev/null 2>&1; then
        if command -v runuser >/dev/null; then runuser -u postgres -- "$@"
        else sudo -u postgres "$@"; fi
    else
        die "нет системного пользователя postgres — создайте роль/БД вручную для '$DB_USER'"
    fi
}

cmd_dest() {
    local bundle="${1:-}" start=0
    shift || true
    [ "${1:-}" = "--start" ] && start=1
    [ -f "$bundle" ] || die "нет bundle: $bundle (использование: migrate-usdt.sh dest <bundle.tar.gz> [--start])"
    [ "$(id -u)" = "0" ] || die "запускайте от root (права 0600 на секреты, systemd, postgres)"

    # --- распаковка
    local stage; stage="$(mktemp -d /tmp/forkex-usdt-dest.XXXXXX)"
    tar -xzf "$bundle" -C "$stage" || die "bundle повреждён"
    mkdir -p "$SCRIPTS_DIR" "$WALLETS_DIR" "$OPS_DIR" /app/forkex /opt/forkex-usdt-migrate
    cp -a "$stage/app/forkex/server/scripts/." "$SCRIPTS_DIR/"
    cp -a "$stage/app/forkex/server/wallets/usdt-wallet.js" "$WALLETS_DIR/"
    [ -f "$stage/app/forkex/.env" ] && cp "$stage/app/forkex/.env" "$KIT_ENV"
    cp "$stage/etc/lbtc-ops/usdt-ops.env" "$stage/etc/lbtc-ops/lbtc-ops.env" "$OPS_DIR/"
    cp "$stage/etc/systemd/system/$UNIT" "$UNIT_PATH"
    chmod 600 "$OPS_DIR/usdt-ops.env" "$OPS_DIR/lbtc-ops.env"
    [ -f "$KIT_ENV" ] && chmod 600 "$KIT_ENV"
    local dump="$stage/opt/forkex-usdt-migrate/kit-db.dump"
    local manifest="$stage/opt/forkex-usdt-migrate/manifest.env"
    [ -f "$dump" ] && [ -f "$manifest" ] || die "в bundle нет дампа/manifest.env"
    [ -f "$STATE_FILE" ] || die "state-файл не поставлен в $STATE_FILE"
    log "файлы разложены: скрипты, кошелёк, конфиги, юнит, state-файл"

    # --- I2: связка курсор<->дамп
    # shellcheck disable=SC1090
    . "$manifest"
    local cursor state_sha dsha
    cursor="$(cursor_value)"
    [ "$cursor" -gt 0 ] || die "курсор=0 — связка неполноценна, монитор пропустит депозиты (см. I2)"
    [ "$cursor" = "$last_scanned_block" ] || die "курсор($cursor) != manifest($last_scanned_block) — перепутаны связки"
    state_sha="$(sha256sum "$STATE_FILE" | awk '{print $1}')"
    [ "$state_sha" = "$state_sha256" ] || die "state-файл изменился относительно manifest"
    dsha="$(sha256sum "$dump" | awk '{print $1}')"
    [ "$dsha" = "$dump_sha256" ] || die "дамп изменился относительно manifest"
    log "связка согласована: курсор=$cursor, источник=$source_host"

    load_env_chain; db_vars

    # --- postgres: роль/БД, реставрация
    command -v pg_restore >/dev/null || die "нет pg_restore (apt install postgresql-client)"
    pg_isready -h "$DB_HOST" -p "$DB_PORT" -q || die "postgres недоступен: $DB_HOST:$DB_PORT"
    local conns
    conns="$(db_scalar "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid()")"
    if [ "${conns:-0}" -gt 0 ]; then
        warn "к БД $DB_NAME подключено клиентов: $conns — реставрация с --clean уронит их схемы; остановите api/web на приёмнике"
    fi
    # роль и БД (если их нет)
    if ! as_postgres psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
        local esc="${DB_PASSWORD//\'/\'\'}"
        as_postgres psql -qc "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$esc'"
        log "создана роль $DB_USER"
    fi
    if ! as_postgres psql -Atqc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
        as_postgres createdb -O "$DB_USER" "$DB_NAME"
        log "создана БД $DB_NAME"
    fi
    log "реставрирую дамп в $DB_NAME (--clean --if-exists — повторный запуск безопасен)"
    PGPASSWORD="$DB_PASSWORD" pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
        --dbname="$DB_NAME" --clean --if-exists --no-owner --no-privileges --jobs=2 \
        "$dump" || die "pg_restore упал"
    log "реставрация завершена"

    # --- I3/I4/I5/I6: проверки
    local holds usdt_dep
    holds="$(holds_max_block)"
    [ "${holds:-0}" -le "$cursor" ] || die "инвариант I3 после реставрации: MAX(holds)=$holds > курсор=$cursor"
    usdt_dep="$(db_scalar "SELECT COUNT(*) FROM deposits WHERE coin_id = ${usdt_coin_id:-27}::int")"
    log "БД восстановлена: депозитов USDT=$usdt_dep (в manifest: $deposits_usdt_count)"
    [ "$usdt_dep" = "$deposits_usdt_count" ] || warn "число депозитов не совпало с manifest"

    if ! cmd_verify; then die "проверки инвариантов на приёмнике не прошли — запуск монитора отменён"; fi

    # --- юнит: если путь node из источника не существует — переписать на локальный
    local node_path esrc
    node_path="$(node_bin)"; [ -n "$node_path" ] || die "node не найден"
    esrc="$(grep -oP '(?<=ExecStart=)[^ ]+' "$UNIT_PATH" || true)"
    if [ -n "$esrc" ] && [ ! -x "${esrc%% *}" ]; then
        sed -i "s|^ExecStart=.*|ExecStart=$node_path $SCRIPTS_DIR/$MONITOR_JS|" "$UNIT_PATH"
        log "ExecStart переписан на $node_path"
    fi

    # --- тест одного цикла ДО включения сервиса (I4: безопасен — ON CONFLICT DO NOTHING)
    log "тестовый цикл: node scripts/$MONITOR_JS once"
    ( cd "$SERVER_DIR" && NODE_PATH="$SERVER_DIR/node_modules" "$node_path" "scripts/$MONITOR_JS" once ) \
        || die "тестовый цикл упал — смотрите вывод выше"
    log "тестовый цикл прошёл; курсор теперь: $(cursor_value)"

    rm -rf "$stage"
    if [ "$start" = "1" ]; then
        systemctl daemon-reload
        systemctl enable --now "$UNIT"
        sleep 2
        log "$UNIT запущен: $(systemctl is-active "$UNIT") — журнал: journalctl -u $UNIT -f"
    else
        log "не запущено. После контроля: migrate-usdt.sh dest --start  (или systemctl enable --now $UNIT)"
    fi

    cat >&2 <<'EOF'

=== ПОМНИТЕ ===
1) Монитор на ИСТОЧНИКЕ отключён (stop+disable) — I1: один монитор на одну БД.
2) Ключ hot-кошелька теперь на двух серверах — usdt-withdraw.js запускать только
   на одном хосте за раз (конфликт nonce). См. I7.
3) Удалите bundle с секретами: rm <bundle.tar.gz>
4) Откат на источнике: systemctl enable --now usdt-monitor.service
EOF
}

case "${1:-help}" in
    source) shift; cmd_source "$@" ;;
    dest)   shift; cmd_dest "$@" ;;
    verify) shift; cmd_verify "$@" ;;
    help|*)
        sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
        ;;
esac
