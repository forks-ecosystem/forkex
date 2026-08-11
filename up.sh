#!/bin/bash
# Остановить старые контейнеры (запущенные из разных папок)
echo "=== Stopping old containers ==="
for c in forkex-db forkex-redis forkex-api forkex-plugins forkex-ws forkex-web forkex-nginx forkex-bot price-oracle forkex-affiliation; do
  if docker ps -q --filter name=$c | grep -q .; then
    echo "Stopping $c..."
    docker stop $c && docker rm $c
  fi
done

# Удаляем старую сеть (если никто не использует)
docker network rm forkex-network 2>/dev/null && echo "Network removed" || echo "Network in use or not found"

# Запускаем единый compose
echo ""
echo "=== Starting unified ForkEX ==="
docker compose -f /app/forkex/docker-compose.yaml up -d
