#cd /opt/forkex/nginx

COMPOSE="docker compose"

PROJECT_DIR="/opt/forkex/server"
NGINX_DIR="/opt/forkex/web"


cd "$NGINX_DIR"
$COMPOSE -f docker-compose.yaml down
$COMPOSE -f docker-compose.yaml up -d
cd "$PROJECT_DIR"


