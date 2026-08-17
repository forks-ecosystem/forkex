FROM nginx:1.25.3-alpine3.18

# Копируем конфиг как шаблон
COPY nginx.conf /etc/nginx/nginx.conf.template

# Создаем директории для сертификатов
RUN mkdir -p /etc/nginx/letsencrypt

# Создаем директорию для статики (если нужно)
RUN mkdir -p /var/www/html

RUN apk add --no-cache certbot py-pip gettext && \
    apk add --no-cache --virtual .build-deps build-base libffi-dev openssl-dev python3-dev && \
    pip install certbot-nginx && \
    apk del .build-deps

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
EXPOSE 443
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
