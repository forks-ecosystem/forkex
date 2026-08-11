cd /app/forkex/price-oracle
cat > run.sh << 'EOF'
#!/bin/bash

# Загружаем переменные окружения
if [ -f "/app/forkex/.env" ]; then
    export $(grep -v '^#' /app/forkex/.env | xargs)
fi

# Запускаем price-oracle
./price-oracle
EOF

chmod +x run.sh