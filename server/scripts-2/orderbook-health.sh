#!/usr/bin/env bash
# orderbook-health.sh — проверка здоровья стакана биржи ForkEX (за последние 24 часа)
#
# Запуск:
#   ./orderbook-health.sh           — однократный отчёт
#   ./orderbook-health.sh 300       — повторять каждые 300 сек (watch-режим)
#
# Пороги (можно переопределить env):
#   TH_SPREAD_PCT    — спред выше значения (% от mid) -> WARN  (по умолч. 1.0)
#   TH_AGE_WARN_MIN  — возраст последней свечи (мин) -> WARN   (по умолч. 10)
#   TH_AGE_CRIT_MIN  — возраст последней свечи (мин) -> CRIT   (по умолч. 30)

WATCH="${1:-0}"
TH_SPREAD_PCT="${TH_SPREAD_PCT:-1.0}"
TH_AGE_WARN_MIN="${TH_AGE_WARN_MIN:-10}"
TH_AGE_CRIT_MIN="${TH_AGE_CRIT_MIN:-30}"
CANDLE_INTERVAL_MIN=5
EXPECTED_24H=$(( 24*60 / CANDLE_INTERVAL_MIN ))

PSQL="docker exec forkex-db psql -U admin -d hollaex -A -t -F| -c"

W=/tmp/obh_warn
C=/tmp/obh_crit
: > "$W"
: > "$C"

warn(){ echo "  [WARN] $*"; echo x >> "$W"; }
crit(){ echo "  [CRIT] $*"; echo x >> "$C"; }
ok(){   echo "  [ OK ] $*"; }
info(){ echo "  [INFO] $*"; }

report(){
  echo "================================================================"
  echo "ForkEX · здоровье стакана · $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "================================================================"

  # ---- 1. Стакан: открытые ордера по парам ----
  echo
  echo "--- Стакан (открытые ордера), спред от mid ---"
  $PSQL "SELECT p.symbol,
       count(CASE WHEN o.status='open' THEN 1 END)                                                                 AS open_orders,
       round((sum(CASE WHEN o.status='open' AND o.side='buy' THEN o.size ELSE 0 END))::numeric,8)                  AS bid_size,
       round((sum(CASE WHEN o.status='open' AND o.side='sell' THEN o.size ELSE 0 END))::numeric,8)                 AS ask_size,
       max(CASE WHEN o.status='open' AND o.side='buy' THEN o.price END)                                            AS best_bid,
       min(CASE WHEN o.status='open' AND o.side='sell' THEN o.price END)                                           AS best_ask,
       count(DISTINCT CASE WHEN o.status='open' AND o.side='buy' THEN o.price END)                                 AS bid_levels,
       count(DISTINCT CASE WHEN o.status='open' AND o.side='sell' THEN o.price END)                                AS ask_levels
  FROM pairs p LEFT JOIN orders o ON o.pair_id=p.id
 WHERE p.active
 GROUP BY p.symbol ORDER BY p.symbol" \
  | while IFS='|' read -r sym open bid ask bb ba bl al; do
      if [ -z "$open" ] || [ "$open" -eq 0 ]; then
        warn "$sym: стакан ПУСТ (нет открытых ордеров)"
        continue
      fi
      line="$(printf '%-10s ордеров=%-3s bid=∑%s ask=∑%s уровни=%s/%s' "$sym" "$open" "${bid:-0}" "${ask:-0}" "${bl:-0}" "${al:-0}")"
      if [ -n "$bb" ] && [ -n "$ba" ]; then
        spread=$(awk -v b="$bb" -v a="$ba" 'BEGIN{ if(b>0&&a>0) printf "%.4f", (a-b)/((a+b)/2)*100; else print "inf" }')
        mid=$(awk -v b="$bb" -v a="$ba" 'BEGIN{ printf "%.8g", (a+b)/2 }')
        line="$line | bid=$bb ask=$ba mid=$mid spread=$spread%"
        if [ "$spread" = "inf" ]; then
          warn "$line (нет пары bid/ask)"
        elif awk -v s="$spread" -v t="$TH_SPREAD_PCT" 'BEGIN{exit !(s>t)}'; then
          warn "$line (спред > ${TH_SPREAD_PCT}%)"
        else
          ok "$line"
        fi
      else
        [ -z "$bb" ] && warn "$sym: односторонний стакан — нет buy (лучший bid пуст)"
        [ -z "$ba" ] && warn "$sym: односторонний стакан — нет sell (лучший ask пуст)"
        echo "       $line"
      fi
    done

  # ---- 2. Сделки за последние 24 часа ----
  echo
  echo "--- Сделки за 24 часа ---"
  $PSQL "SELECT COALESCE(symbol,'(нет)'), count(*), round(sum(size*price)::numeric,6) FROM trades
          WHERE timestamp >= NOW() - INTERVAL '24 hours' GROUP BY symbol ORDER BY symbol" \
  | while IFS='|' read -r sym cnt notional; do
      info "$(printf '%-10s сделок=%-5s объём(notional)=%s' "$sym" "${cnt:-0}" "${notional:-0}")"
    done
  none=$($PSQL "SELECT count(*) FROM trades WHERE timestamp >= NOW() - INTERVAL '24 hours'")
  [ "${none:-0}" -eq 0 ] && warn "за 24ч сделок нет вообще"

  # ---- 3. Свечи: свежесть и покрытие за 24ч ----
  echo
  echo "--- Свечи 5m: возраст последней и покрытие за 24ч ---"
  now=$($PSQL "SELECT EXTRACT(EPOCH FROM NOW())::bigint")
  $PSQL "SELECT p.symbol,
       max(c.timestamp)                                                                                          AS last_ts,
       count(c.id) FILTER (WHERE c.timestamp >= (EXTRACT(EPOCH FROM NOW())::bigint - 86400))                     AS have_24h
  FROM pairs p LEFT JOIN candles c ON c.pair_id=p.id AND c.timeframe='5m'
 WHERE p.active GROUP BY p.symbol ORDER BY p.symbol" \
  | while IFS='|' read -r sym last_ts have; do
      if [ -z "$last_ts" ]; then
        crit "$sym: свечей НЕТ"
        continue
      fi
      age=$(( (now - last_ts) / 60 ))
      if [ "$age" -gt "$TH_AGE_CRIT_MIN" ]; then
        crit "$(printf '%-10s свежесть=%s мин (нет свечки %s мин)' "$sym" "$age" "$TH_AGE_CRIT_MIN")"
      elif [ "$age" -gt "$TH_AGE_WARN_MIN" ]; then
        warn "$(printf '%-10s свежесть=%s мин (ожидалось ≥1 свечки за %s мин)' "$sym" "$age" "$CANDLE_INTERVAL_MIN")"
      else
        ok "$(printf '%-10s свежесть=%s мин, свечей за 24ч=%s/%s' "$sym" "$age" "${have:-0}" "$EXPECTED_24H")"
      fi
    done

  # ---- 4. Боты-маркет-мейкеры (bot_configs + реальная активность strategy_history) ----
  echo
  echo "--- Боты-маркет-мейкеры (активные) ---"
  $PSQL "SELECT bc.id, bc.name, bc.parameters->>'symbol' AS sym,
       round(EXTRACT(EPOCH FROM (NOW()-max(h.created_at)))/60)::int          AS age_min,
       count(h.id) FILTER (WHERE h.created_at > NOW() - interval '30 minutes') AS evt_30m,
       count(h.id) FILTER (WHERE h.created_at > now() - interval '30 minutes' AND coalesce(h.state,'')='error') AS err_30m
  FROM bot_configs bc LEFT JOIN strategy_history h ON h.strategy_id=bc.id
  WHERE bc.is_active GROUP BY bc.id, bc.name, bc.parameters->>'symbol' ORDER BY bc.id" \
  | while IFS='|' read -r id name sym age evt err; do
      if [ -z "$age" ]; then age=1200; fi
      if [ "${err:-0}" -gt 0 ]; then
        warn "$(printf '[ %-3s ] %-28s %-10s errors_30m=%s' "$id" "$name" "$sym" "$err")"
      elif [ "$age" -gt "$TH_AGE_CRIT_MIN" ]; then
        warn "$(printf '[ %-3s ] %-28s %-10s нет активности %s мин' "$id" "$name" "$sym" "$age")"
      elif [ "$age" -gt "$TH_AGE_WARN_MIN" ]; then
        warn "$(printf '[ %-3s ] %-28s %-10s активность %s мин назад, событий/30м=%s' "$id" "$name" "$sym" "$age" "${evt:-0}")"
      else
        ok "$(printf '[ %-3s ] %-28s %-10s активность %s мин назад, событий/30м=%s' "$id" "$name" "$sym" "$age" "${evt:-0}")"
      fi
    done
  mm_count=$($PSQL "SELECT count(*) FROM bot_configs WHERE is_active")
  [ "${mm_count:-0}" -gt 0 ] || crit "нет активных ботов-маркет-мейкеров"

  # ---- 5. Движение цены за сутки (по свечам) ----
  echo
  echo "--- Движение цены за сутки (close первой → последней свечи) ---"
  $PSQL "SELECT p.symbol,
       (SELECT c1.close FROM candles c1 WHERE c1.pair_id=p.id AND c1.timeframe='5m' ORDER BY c1.timestamp ASC  LIMIT 1) AS c_first,
       (SELECT c2.close FROM candles c2 WHERE c2.pair_id=p.id AND c2.timeframe='5m' ORDER BY c2.timestamp DESC LIMIT 1) AS c_last
  FROM pairs p WHERE p.active ORDER BY p.symbol" \
  | while IFS='|' read -r sym cf cl; do
      if [ -z "$cf" ] || [ -z "$cl" ]; then
        info "$(printf '%-10s нет свечей' "$sym")"
        continue
      fi
      chg=$(awk -v f="$cf" -v l="$cl" 'BEGIN{ if(f>0) printf "%.3f", (l-f)/f*100; else print "inf" }')
      info "$(printf '%-10s %s → %s (%s%%)' "$sym" "$cf" "$cl" "$chg")"
    done

  # ---- Итог ----
  echo
  wc=$(wc -l < "$W" 2>/dev/null || echo 0)
  cc=$(wc -l < "$C" 2>/dev/null || echo 0)
  if [ "$cc" -gt 0 ]; then
    echo "ИТОГ: [CRIT] проблем: $cc, предупреждений: $wc"
  elif [ "$wc" -gt 0 ]; then
    echo "ИТОГ: [WARN] предупреждений: $wc"
  else
    echo "ИТОГ: [ OK ]  стакан здоров"
  fi
  echo
}

while :; do
  report
  [ "$WATCH" -gt 0 ] || break
  sleep "$WATCH"
done