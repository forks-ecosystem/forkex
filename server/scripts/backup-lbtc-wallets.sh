#!/bin/sh
# Nightly backup of the node's wallet files, including the "users" wallet that
# now holds user deposit keys. The keys are stored in these files in the clear,
# so the destination must stay root-only (0600) and be copied off-host.
#
# Cron (root):  17 3 * * * /app/forkex/server/scripts/backup-lbtc-wallets.sh >/dev/null 2>&1
set -eu

SRC=${LBTC_WALLET_SRC:-/home/coin/.legacycoin}
DST=${LBTC_WALLET_BACKUP_DIR:-/etc/lbtc-ops/wallet-backups}
STAMP=$(date +%Y%m%d-%H%M%S)
RETAIN_DAYS=${LBTC_WALLET_BACKUP_DAYS:-14}

mkdir -p "$DST"

if [ -f "$SRC/wallet.json" ]; then
	cp "$SRC/wallet.json" "$DST/default-wallet-$STAMP.json"
fi

for d in "$SRC"/wallets/*/; do
	[ -f "$d/wallet.json" ] || continue
	name=$(basename "$d")
	cp "$d/wallet.json" "$DST/$name-wallet-$STAMP.json"
done

chmod 600 "$DST"/*.json 2>/dev/null || true
find "$DST" -name '*-wallet-*.json' -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true

echo "backup complete: $STAMP ($(ls "$DST"/*-wallet-*.json 2>/dev/null | wc -l) files)"
