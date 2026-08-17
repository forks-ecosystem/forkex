FROM nginx:1.25.3-alpine3.18

COPY nginx.conf /etc/nginx/templates/nginx.conf.template

RUN mkdir -p /etc/nginx/letsencrypt /var/www/html

RUN apk add --no-cache gettext

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
EXPOSE 443
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
