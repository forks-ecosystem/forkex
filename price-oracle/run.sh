cd /opt/forkex/price-oracle
cat > run.sh << 'EOF'
#!/bin/bash

# Загружаем переменные окружения
if [ -f "/opt/forkex/.env" ]; then
    export $(grep -v '^#' /opt/forkex/.env | xargs)
fi

# Запускаем price-oracle
./price-oracle
EOF

chmod +x run.sh