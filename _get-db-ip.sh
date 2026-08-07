#!/bin/bash
# /opt/forkex/_get-db-ip.sh - Простая версия
DB_IP_FILE="/tmp/db_ip.txt"
DB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' forkex-db 2>/dev/null)
if [ -n "$DB_IP" ] && [ "$DB_IP" != "0.0.0.0" ]; then
    echo "$DB_IP" > "$DB_IP_FILE"
fi
