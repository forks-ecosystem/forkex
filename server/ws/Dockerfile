FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV WS_PORT=10011
ENV WS_VERBOSE=1

EXPOSE 10011

CMD ["node", "ws-server.js"]

