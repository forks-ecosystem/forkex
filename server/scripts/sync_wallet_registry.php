<?php
/**
 * sync_wallet_registry.php
 * 
 * Синхронизация балансов wallet_registry с нодой через legacycoreagent.
 * 
 * Мультикошелёчная нода: listunspent возвращает только default-кошелёк,
 * если не передан заголовок X-LegacyCoin-Wallet. Поэтому:
 *   1) список кошельков → GET /api/wallets (агент)
 *   2) для каждого → RPC listunspent с заголовком
 *   3) агрегация по адресам, обновление last_balance
 * 
 * Использование:
 *   php sync_wallet_registry.php
 *   php sync_wallet_registry.php --dry-run
 *   php sync_wallet_registry.php --verbose
 */

// ---------- Загрузка p4.php (несколько путей для надёжности) ----------
$p4='hollaex-db';require('/var/www/html/hollaex/p4.php');
if (!isset($dbconn) || !$dbconn) {
    fwrite(STDERR, "ERROR: \$dbconn not initialized\n");
    exit(1);
}

// ---------- Конфигурация ----------
$CONFIG = [
    'rpc'        => 'http://127.0.0.1:19556',
    'auth'       => '',  // .cookie wins (cookie-only node since 2026-11-12); see auth_pair()
    'agent'      => 'http://127.0.0.1:8444',
    'key'        => '62u6HL6vgNnACj2gm2braH6AE9WqVyLDmTrsJl6h0I=',
    'coin_symbol'=> 'lbtc',
    'timeout'    => 60,
    'min_conf'   => 0,        // учитывать все UTXO (включая 0-conf, если есть)
    'skip_immature' => true,  // пропускать coinbase < 100 conf
    'coinbase_conf' => 100,
];

$DRY = in_array('--dry-run', $argv ?? [], true);
$VERBOSE = in_array('--verbose', $argv ?? [], true) || $DRY;

// ---------- Маппинг: кошелёк ноды → purpose по умолчанию ----------
// Используется только для НОВЫХ адресов, которых нет в wallet_registry.
// Существующие адреса сохраняют свой purpose.
$WALLET_PURPOSE_MAP = [
    'mainer'         => 'mainer',
    'pool'           => 'pool',
    'users'          => 'users',
    'withdrawal'     => 'withdrawal',
    'fee_withdrawal' => 'fee_withdrawal',
    'fee_trade'      => 'fee_trade',
    'bots'           => 'bots',
    'default'        => 'default',
    'exchange'       => 'unknown',   // смешанный: cold/treasury/hot/fee/... — ручная классификация
];

// ---------- RPC ----------
// Node runs cookie-only since 2026-11-12 (no rpcuser/rpcpassword in
// legacycoin.conf; static credentials are rejected with 401). Auth comes from
// the datadir .cookie, re-read per call so a rotated cookie is picked up.
function auth_pair() {
    static $cached = null;
    $cookie = '/home/coin/.legacycoin/.cookie';
    $c = @file_get_contents($cookie);
    if ($c !== false) {
        $c = trim($c);
        if ($c !== '' && strpos($c, ':') !== false) { $cached = $c; return $c; }
    }
    return $cached ?: '';
}

function rpc_call($method, $params = [], $wallet = '') {
    global $CONFIG;
    $auth = $CONFIG['auth'] !== '' ? $CONFIG['auth'] : auth_pair();
    if ($auth === '') return ['error' => "rpc $method: no auth (cookie missing and no static fallback configured)"];
    $ch = curl_init($CONFIG['rpc']);
    $headers = ['Content-Type: application/json'];
    if ($wallet !== '') $headers[] = 'X-LegacyCoin-Wallet: ' . $wallet;
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERPWD        => $auth,
        CURLOPT_TIMEOUT        => $CONFIG['timeout'],
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode([
            'jsonrpc' => '2.0', 'id' => 'sync', 'method' => $method, 'params' => $params
        ]),
        CURLOPT_HTTPHEADER     => $headers,
    ]);
    $r = curl_exec($ch);
    $e = curl_error($ch);
    curl_close($ch);
    if ($r === false) return ['error' => "rpc $method: $e"];
    $j = json_decode($r, true);
    if (!is_array($j)) return ['error' => "rpc $method: bad json"];
    if (isset($j['error'])) {
        $msg = is_array($j['error']) ? ($j['error']['message'] ?? json_encode($j['error'])) : (string)$j['error'];
        return ['error' => "rpc $method: $msg"];
    }
    if (!array_key_exists('result', $j)) return ['error' => "rpc $method: no result"];
    return $j['result'];
}

// ---------- Агент ----------
function agent_call($path) {
    global $CONFIG;
    $ch = curl_init($CONFIG['agent'] . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERAGENT      => 'sync-registry/1.0',
        CURLOPT_TIMEOUT        => $CONFIG['timeout'],
        CURLOPT_HTTPHEADER     => ['X-Api-Key: ' . $CONFIG['key']],
    ]);
    $r = curl_exec($ch);
    $e = curl_error($ch);
    curl_close($ch);
    if ($r === false) return ['error' => "agent $path: $e"];
    $j = json_decode($r, true);
    return is_array($j) ? $j : ['error' => "agent $path: bad json"];
}

// ---------- Список кошельков ----------
function get_wallets() {
    $r = agent_call('/api/wallets');
    if (isset($r['wallets']) && is_array($r['wallets'])) {
        $out = [];
        foreach ($r['wallets'] as $w) {
            $w = trim((string)$w);
            if ($w !== '') $out[] = $w;
        }
        if ($out) return $out;
    }
    // fallback — если агент недоступен
    return ['default','bots','exchange','fee_trade','fee_withdrawal','mainer','pool','users','withdrawal'];
}

// ---------- Сумма UTXO в base_units ----------
function utxo_amount($o) {
    if (!is_array($o)) return 0;
    foreach (['amount_base_units','value_base_units'] as $k) {
        if (isset($o[$k]) && is_numeric($o[$k])) return (int)$o[$k];
    }
    foreach (['amount','value'] as $k) {
        if (isset($o[$k]) && is_numeric($o[$k])) return (int)round(((float)$o[$k]) * 100000000);
    }
    return 0;
}

// ---------- Основная логика ----------
function main() {
    global $CONFIG, $dbconn, $WALLET_PURPOSE_MAP, $DRY, $VERBOSE;

    // 1. Определить coin_id
    $r = pg_query_params($dbconn,
        "SELECT id FROM coins WHERE symbol = $1", [$CONFIG['coin_symbol']]);
    if (!$r || pg_num_rows($r) === 0) {
        fwrite(STDERR, "ERROR: coin '{$CONFIG['coin_symbol']}' not found\n");
        return 1;
    }
    $coin_id = (int)pg_fetch_result($r, 0, 0);

    // 2. Получить список кошельков
    $wallets = get_wallets();
    if ($VERBOSE) printf("wallets from agent: %d [%s]\n", count($wallets), implode(',', $wallets));

    // 3. Обойти все кошельки, собрать UTXO по адресам
    $byAddr = [];        // addr => ['balance' => int, 'utxo' => int, 'wallet' => string]
    $walletErrors = [];
    $stats = [
        'wallets_ok'      => 0,
        'wallets_err'     => 0,
        'utxo_total'      => 0,
        'immature_skipped'=> 0,
        'locked_skipped'  => 0,
        'zero_skipped'    => 0,
    ];

    foreach ($wallets as $w) {
        $utxos = rpc_call('listunspent', [0, 9999999], $w);
        if (isset($utxos['error'])) {
            $walletErrors[$w] = $utxos['error'];
            $stats['wallets_err']++;
            if ($VERBOSE) fprintf(STDERR, "  [!] $w: {$utxos['error']}\n");
            continue;
        }
        if (!is_array($utxos)) continue;
        $stats['wallets_ok']++;
        $wCount = 0;

        foreach ($utxos as $o) {
            if (!is_array($o)) continue;
            $addr = $o['address'] ?? '';
            if ($addr === '') continue;

            // пропустить locked
            if (!empty($o['locked'])) { $stats['locked_skipped']++; continue; }

            $amt = utxo_amount($o);
            if ($amt <= 0) { $stats['zero_skipped']++; continue; }

            // пропустить immature coinbase
            $conf = (int)($o['confirmations'] ?? 0);
            if ($CONFIG['skip_immature'] && !empty($o['coinbase']) && $conf < $CONFIG['coinbase_conf']) {
                $stats['immature_skipped']++;
                continue;
            }

            if (!isset($byAddr[$addr])) {
                $byAddr[$addr] = ['balance' => 0, 'utxo' => 0, 'wallet' => $w];
            }
            $byAddr[$addr]['balance'] += $amt;
            $byAddr[$addr]['utxo']++;
            $stats['utxo_total']++;
            $wCount++;
        }
        if ($VERBOSE) printf("  [ok] %-16s → %d utxo, %d addresses\n", $w, $wCount, count($byAddr));
    }

    // 4. Найти существующие адреса в реестре
    $existing = [];      // addr => ['id' => int, 'purpose' => string, 'kind' => string]
    $r = pg_query_params($dbconn,
        "SELECT id, address, purpose, kind FROM wallet_registry WHERE coin_id = $1",
        [$coin_id]);
    while ($row = pg_fetch_assoc($r)) {
        $existing[$row['address']] = $row;
    }

    // 5. Классифицировать адреса
    $toUpdate = [];      // адреса, которые уже в реестре
    $toInsert = [];      // новые адреса (нет в реестре)
    foreach ($byAddr as $addr => $data) {
        if (isset($existing[$addr])) {
            $toUpdate[$addr] = $data;
        } else {
            $toInsert[$addr] = $data;
        }
    }

    // 6. Новые адреса — определить purpose из кошелька
    foreach ($toInsert as $addr => &$data) {
        $w = $data['wallet'];
        $data['purpose'] = $WALLET_PURPOSE_MAP[$w] ?? 'unknown';
        $data['kind'] = ($data['purpose'] === 'unknown') ? 'change' : 'change';
        // kind='change' безопаснее для новых; юзер выставит 'main' вручную при необходимости
    }
    unset($data);

    // 7. Сумма on-chain (все UTXO)
    $totalOnChain = 0;
    foreach ($byAddr as $d) $totalOnChain += $d['balance'];

    // 8. Вывести статистику
    printf("\n=== Sync wallet_registry for %s ===\n", strtoupper($CONFIG['coin_symbol']));
    printf("Coin ID:         %d\n", $coin_id);
    printf("Wallets OK:      %d (errors: %d)\n", $stats['wallets_ok'], $stats['wallets_err']);
    printf("UTXO total:      %d\n", $stats['utxo_total']);
    printf("Skipped:         immature=%d, locked=%d, zero=%d\n",
        $stats['immature_skipped'], $stats['locked_skipped'], $stats['zero_skipped']);
    printf("On-chain addrs:  %d\n", count($byAddr));
    printf("  → to update:   %d\n", count($toUpdate));
    printf("  → to insert:   %d\n", count($toInsert));
    printf("On-chain total:  %.8f %s\n", $totalOnChain / 1e8, strtoupper($CONFIG['coin_symbol']));

    if ($walletErrors) {
        printf("\nWallet errors:\n");
        foreach ($walletErrors as $w => $e) printf("  [%s] %s\n", $w, $e);
    }

    if ($VERBOSE && $toInsert) {
        printf("\nNew addresses (top 20 by balance):\n");
        $sort = $toInsert;
        uasort($sort, fn($a, $b) => $b['balance'] <=> $a['balance']);
        $i = 0;
        foreach ($sort as $addr => $d) {
            if ($i++ >= 20) break;
            printf("  %s  %-16s %-10s %.8f (%d utxo)\n",
                $addr, $d['purpose'], $d['kind'], $d['balance']/1e8, $d['utxo']);
        }
    }

    if ($DRY) {
        printf("\n[DRY-RUN] No DB changes.\n");
        return 0;
    }

    // 9. Обновить БД
    pg_query($dbconn, 'BEGIN');
    try {
        // 9a. Обнулить last_balance и utxo_count у всех
        pg_query_params($dbconn,
            "UPDATE wallet_registry
             SET last_balance = 0, utxo_count = 0, last_synced_at = now()
             WHERE coin_id = $1",
            [$coin_id]);

        // 9b. Обновить существующие
        $updated = 0;
        $upd = pg_prepare($dbconn, 'upd',
            "UPDATE wallet_registry
             SET last_balance = $1, utxo_count = $2, last_synced_at = now()
             WHERE coin_id = $3 AND address = $4");
        foreach ($toUpdate as $addr => $d) {
            $r = pg_execute($dbconn, 'upd',
                [$d['balance'] / 1e8, $d['utxo'], $coin_id, $addr]);
            if ($r) $updated += pg_affected_rows($r);
        }

        // 9c. Вставить новые
        $inserted = 0;
        $ins = pg_prepare($dbconn, 'ins',
            "INSERT INTO wallet_registry
             (coin_id, address, purpose, kind, source, note, last_balance, utxo_count, last_synced_at, status)
             VALUES ($1, $2, $3, $4, 'from_node', $5, $6, $7, now(), 'active')
             ON CONFLICT (coin_id, address) DO NOTHING");
        foreach ($toInsert as $addr => $d) {
            $note = "auto-discovered via wallet '$d[wallet]'";
            $r = pg_execute($dbconn, 'ins',
                [$coin_id, $addr, $d['purpose'], $d['kind'], $note,
                 $d['balance'] / 1e8, $d['utxo']]);
            if ($r) $inserted += pg_affected_rows($r);
        }

        pg_query($dbconn, 'COMMIT');

        printf("\nDB updated:      %d rows updated, %d rows inserted\n", $updated, $inserted);
    } catch (Exception $e) {
        pg_query($dbconn, 'ROLLBACK');
        fwrite(STDERR, "\nDB ERROR: {$e->getMessage()}\n");
        return 1;
    }

    // 10. Проверка сходимости
    printf("\n=== Reconciliation ===\n");
    $r = pg_query_params($dbconn,
        "SELECT COALESCE(SUM(last_balance), 0) AS total, COUNT(*) AS cnt
         FROM wallet_registry WHERE coin_id = $1", [$coin_id]);
    $rec = pg_fetch_assoc($r);
    $registryTotal = (float)$rec['total'];
    $diff = $totalOnChain - ($registryTotal * 1e8);
    printf("On-chain:        %.8f\n", $totalOnChain / 1e8);
    printf("Registry sum:    %.8f\n", $registryTotal);
    printf("Diff:            %.8f (%.2f%%)\n",
        $diff / 1e8,
        $totalOnChain > 0 ? ($diff / $totalOnChain * 100) : 0);
    printf("Registry rows:   %d\n", $rec['cnt']);

    // 11. Показать распределение по purposes
    printf("\n=== By purpose ===\n");
    $r = pg_query_params($dbconn,
        "SELECT purpose, kind, COUNT(*) AS cnt,
                COALESCE(SUM(last_balance), 0)::numeric(20,8) AS bal
         FROM wallet_registry
         WHERE coin_id = $1
         GROUP BY purpose, kind
         ORDER BY bal DESC NULLS LAST", [$coin_id]);
    while ($row = pg_fetch_assoc($r)) {
        printf("  %-16s %-8s %3d  %s\n",
            $row['purpose'], $row['kind'], $row['cnt'], $row['bal']);
    }

    return 0;
}

exit(main());
