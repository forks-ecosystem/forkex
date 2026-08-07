# В файле /opt/hollaex-kit/server/tools/Dockerfile
FROM node:20.18.1-bullseye-slim

RUN apt-get update && \
    apt-get install -y curl openssl ca-certificates git python build-essential && \
    rm -rf /var/lib/apt/lists/* && \
    npm install --unsafe-perm=true pm2@5.2.0 sequelize-cli@6.5.1 mocha -g --loglevel=error

ENV NODE_ENV=production

# Копируем всё из родительской директории
COPY ../. /app

# Копируем entrypoint.sh отдельно, если нужно
COPY ../entrypoint.sh /entrypoint.sh

WORKDIR /app

# Changing the default image user to 'appuser'
RUN groupadd -g 999 appuser && \
    useradd -r -u 999 -g appuser appuser && \
    mkdir /home/appuser && \
    chown -R appuser /home/appuser && \
    chown -R appuser /app && \
    chmod +x /entrypoint.sh  # Добавьте эту строку

USER appuser

RUN npm install --loglevel=error && \
    pm2 update && \
    cd /app/mail && npm install --loglevel=error

EXPOSE 10010 10011

ENTRYPOINT ["/entrypoint.sh"]