#cd /opt/forkex/server
docker compose down
docker rmi -f price-oracle-price-oracle || true
docker compose -f docker-compose.yml up -d
