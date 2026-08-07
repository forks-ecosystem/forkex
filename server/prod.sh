#!/bin/bash
set -e

### CONFIG ###
COMPOSE="docker compose"

PROJECT_DIR="/opt/forkex/server"
################

echo "------------------------------------"
echo "   ForkEX  Rebuild & Restart"
echo "------------------------------------"

cd "$PROJECT_DIR"

echo ""
echo " Запускаем контейнеры..."
$COMPOSE -f docker-compose.yaml up -d

echo ""
echo " Проверяем статус..."
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo " Логи сервера (10 секунд для проверки ошибок):"
#timeout 10 docker logs -f forkex-api || true

echo ""
echo "------------------------------------"
echo "       Проект запущен"
echo "------------------------------------"
