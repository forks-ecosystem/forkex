FROM node:20-bullseye-slim

RUN apt-get update && \
    apt-get install -y openssl ca-certificates git python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY ./server /app

WORKDIR /app

RUN npm install --omit=dev --loglevel=error && \
    cd /app/mail && npm install --omit=dev --loglevel=error

RUN groupadd -g 999 appuser && \
    useradd -r -u 999 -g appuser appuser && \
    chown -R appuser /app

USER appuser

EXPOSE 10012

CMD ["node", "plugins/index.js"]
