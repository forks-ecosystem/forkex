FROM nginx:1.25.3-alpine3.18

COPY nginx.conf /etc/nginx/nginx.conf

RUN mkdir -p /etc/nginx/letsencrypt /var/www/html

EXPOSE 80
EXPOSE 443
CMD ["nginx", "-g", "daemon off;"]
