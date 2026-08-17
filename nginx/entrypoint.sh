#!/bin/sh
export DOMAIN=${DOMAIN:-forkex.life}
envsubst '${DOMAIN}' < /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf
exec "$@"
