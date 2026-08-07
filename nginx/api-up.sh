#cd /opt/forkex/nginx
docker compose -f docker-compose.yaml down
docker rmi -f nginx-nginx || true

docker compose -f docker-compose.yaml build --no-cache

docker compose -f docker-compose.yaml up -d
