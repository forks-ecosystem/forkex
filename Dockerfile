FROM node:20.19.0-bullseye-slim

RUN rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list && \
    echo "deb http://archive.debian.org/debian bullseye main" > /etc/apt/sources.list && \
    apt-get update -o Acquire::Check-Valid-Until=false && \
    apt-get install -y --no-install-recommends --allow-downgrades -o Acquire::Check-Valid-Until=false curl openssl ca-certificates git python build-essential perl-base=5.32.1-4+deb11u3 && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY ./server /app

WORKDIR /app

RUN groupadd -g 999 appuser && \
    useradd -r -u 999 -g appuser appuser && \
    mkdir /home/appuser && \
    chown -R appuser /home/appuser && \
    chown -R appuser /app

USER appuser

RUN npm install --loglevel=error && \
    cd /app/mail && npm install --loglevel=error

EXPOSE 10010 10080 10011

CMD ["node", "app.js"]
