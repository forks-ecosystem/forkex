#!/bin/bash
set -euo pipefail

NETWORK_NAME="forkex-network"
ADMIN_CONTAINER="forkex-db-admin"
ADMIN_PORT="5454"

# -----------------------------
# Create docker network
# -----------------------------
if docker network ls --format '{{.Name}}' | grep -q "^${NETWORK_NAME}$"; then
  echo " Docker network '${NETWORK_NAME}' already exists"
else
  echo " Creating Docker network '${NETWORK_NAME}'"
  docker network create --driver bridge "${NETWORK_NAME}"
fi

# -----------------------------
# DB admin proxy (localhost only)
# -----------------------------
if docker ps -a --format '{{.Names}}' | grep -q "^${ADMIN_CONTAINER}$"; then
  echo " DB admin proxy '${ADMIN_CONTAINER}' already exists"
else
  echo " Creating DB admin proxy on 127.0.0.1:${ADMIN_PORT}"

  docker run -d \
    --name "${ADMIN_CONTAINER}" \
    --restart unless-stopped \
    --network "${NETWORK_NAME}" \
    -p 127.0.0.1:${ADMIN_PORT}:5432 \
    alpine/socat \
    tcp-listen:5432,fork,reuseaddr tcp-connect:forkex-db:5432
fi

echo " Network and DB admin proxy are ready"
