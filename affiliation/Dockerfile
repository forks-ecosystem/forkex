FROM node:24-alpine
WORKDIR /app
COPY ./affiliation/package.json ./
RUN npm install --omit=dev --loglevel=error
COPY ./server/affiliation-service.js ./aindex.js
CMD ["node", "aindex.js"]
