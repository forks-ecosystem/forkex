#!/bin/bash

# docker volume rm $(docker volume ls -q)
# docker images | grep forkex

echo "Остановка контейнера server..."
docker compose stop forkex-web
docker compose rm -f forkex-web

echo "Удаляем старый образ forkex-server..."
docker rmi -f forkex-web || true
docker rmi -f forkex-web:latest || true
echo "Пересборка server..."
docker compose build --no-cache

echo "Запуск server..."
docker compose up -d

echo "Готово."
