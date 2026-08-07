#cd /opt/forkex/ws
echo "Остановка контейнера server..."
docker compose stop forkex-ws
docker compose rm forkex-ws

echo "Удаляем старый образ forkex-api..."
docker rmi -f ws-websocket || true


docker compose build
docker compose up -d
