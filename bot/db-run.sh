#cd /opt/forkex/server
docker compose down
docker rmi -f bot-forkex-bot || true
docker compose -f docker-compose.yml up -d
