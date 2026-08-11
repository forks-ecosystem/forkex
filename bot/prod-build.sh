#!/bin/bash
set -e

### CONFIG ###
COMPOSE="docker compose"
IMAGES=("bot-forkex-bot" )

PROJECT_DIR="/app/forkex/bot"
################

echo "------------------------------------"
echo "   ForkEX  Rebuild & Restart"
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
$COMPOSE  build --no-cache

echo ""
echo " Запускаем контейнеры..."
$COMPOSE up -d

#docker run --name forkex-bot --rm -p 8082:8082 forkex-bot

echo ""
echo "------------------------------------"
echo "       Проект запущен"
echo "------------------------------------"
