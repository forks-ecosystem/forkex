#!/bin/bash
set -e

### CONFIG ###
COMPOSE="docker compose"
IMAGES=("forkex" "hollaex-kit-nginx")

PROJECT_DIR="/opt/hollaex-kit/server"
################

echo "------------------------------------"
echo "   HollaEx Kit  Rebuild & Restart"
echo "------------------------------------"

cd "$PROJECT_DIR"

echo ""
echo " Останавливаем контейнеры..."
$COMPOSE down

echo ""
echo " Удаляем старые образы проекта:"
for img in "${IMAGES[@]}"; do
    if docker images | grep -q "$img"; then
        echo " - Удаляем $img"
        docker rmi -f "$img" || true
    else
        echo " - Образ $img отсутствует  пропускаем"
    fi
done

echo ""
echo " Пересобираем проект..."
$COMPOSE build --no-cache

echo ""
echo " Запускаем контейнеры..."
$COMPOSE up -d

echo ""
echo " Проверяем статус..."
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo " Логи сервера (10 секунд для проверки ошибок):"
#timeout 10 docker logs -f hollaex-server || true

echo ""
echo "------------------------------------"
echo "       Проект запущен"
echo "------------------------------------"
