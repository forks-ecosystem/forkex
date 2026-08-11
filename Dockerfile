FROM node:20.19.0-bullseye-slim

RUN apt-get update && \
    apt-get install -y curl openssl ca-certificates git python build-essential && \
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
