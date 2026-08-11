#!/bin/bash
set -e

### CONFIG ###
COMPOSE="docker compose"
IMAGES=("server-forkex-api" "server-forkex-plugins")

PROJECT_DIR="/app/forkex/server"
NGINX_DIR="/app/forkex/web"
################

echo "------------------------------------"
echo "   ForkEX  Rebuild & Restart"
echo "------------------------------------"

cd "$PROJECT_DIR"

echo ""
echo " Останавливаем контейнеры..."
$COMPOSE -f docker-compose.yaml down

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
$COMPOSE  -f docker-compose.yaml build --no-cache

echo ""
echo " Запускаем контейнеры..."
$COMPOSE -f docker-compose.yaml up -d

echo ""
echo "------------------------------------"
echo "       Проект запущен"
echo "------------------------------------"
