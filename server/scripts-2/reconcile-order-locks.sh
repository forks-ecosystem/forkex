#!/usr/bin/env bash
# Keeps balances.locked / balances.available in sync with open orders and
# reports positions that a balance cannot cover.
#
# The exchange engine never reserves anything for an open order: HollaEx only
# settles on fill, so without this the whole balance stays "available" while
# orders are live. Runs from fx-reconcile-locks.timer every minute.
set -uo pipefail

PSQL=(psql -h 127.0.0.1 -p 5434 -U admin -d hollaex -t -A -F'|' -q)
STATE=/app/forkex/server/scripts/.fx-reconcile-state

if ! "${PSQL[@]}" -c "SELECT count(*) FROM fx_apply_locks();" >/dev/null 2>&1; then
    echo "$(date -Is) reconcile FAILED: cannot apply order locks"
    exit 1
fi

summary=$("${PSQL[@]}" -c "
SELECT
  (SELECT count(*) FROM balances WHERE locked > 0),
  (SELECT count(*) FROM fx_order_locks),
  (SELECT count(*) FROM (SELECT 1 FROM fx_order_locks l
      LEFT JOIN balances b ON b.user_id = l.user_id AND b.currency = l.cur
      WHERE l.need > COALESCE(b.balance, 0)
      GROUP BY l.user_id, l.cur) u),
  (SELECT COALESCE(SUM(GREATEST(l.need - COALESCE(b.balance, 0), 0)), 0)
   FROM fx_order_locks l
   LEFT JOIN balances b ON b.user_id = l.user_id AND b.currency = l.cur);")

if [ "$summary" = "$(cat "$STATE" 2>/dev/null)" ]; then
    exit 0
fi

echo "$(date -Is) locked_rows|lock_currencies|uncovered_positions|uncovered_total = $summary"

"${PSQL[@]}" -c "
SELECT '  user ' || l.user_id || ' ' || l.cur
       || ': orders need ' || round(l.need, 6)
       || ', balance ' || round(COALESCE(b.balance, 0), 6)
       || ', uncovered ' || round(GREATEST(l.need - COALESCE(b.balance, 0), 0), 6)
FROM fx_order_locks l
LEFT JOIN balances b ON b.user_id = l.user_id AND b.currency = l.cur
WHERE l.need > COALESCE(b.balance, 0)
ORDER BY GREATEST(l.need - COALESCE(b.balance, 0), 0) DESC;"

printf '%s' "$summary" > "$STATE"
