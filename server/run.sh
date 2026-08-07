#!/bin/bash

# docker volume rm $(docker volume ls -q)
# docker images | grep forkex

echo "Остановка контейнера server..."
docker compose stop forkex-api
docker compose rm -f forkex-api

echo "Удаляем старый образ forkex-api..."
docker rmi -f forkex-api || true

echo "Пересборка server..."
docker compose build --no-cache

echo "Запуск server..."
docker compose up -d

echo "Готово."
