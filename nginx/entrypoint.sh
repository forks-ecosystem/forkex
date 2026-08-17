#!/bin/sh
# Replace ${DOMAIN} in nginx.conf with actual value from env
export DOMAIN=${DOMAIN:-forkex.life}
envsubst '${DOMAIN}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
exec "$@"
