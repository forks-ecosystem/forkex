echo "=== Полная проверка всех endpoints ==="

echo "1. /v2/kit/ (существующий):"
curl -sk "https://forkex.life/v2/kit/" | jq -r '.api_name // "ERROR"' 2>/dev/null && echo "1.✅" || echo "2.❌"

echo -e "\n2. /v2/kit/config (редирект):"
curl -sk "https://forkex.life/v2/kit/config" | jq -r '.api_name // "ERROR"' 2>/dev/null && echo "1.✅" || echo "2.❌"

echo -e "\n3. /v2/health:"
curl -sk "https://forkex.life/v2/health" | jq -r '.name // "ERROR"' 2>/dev/null && echo "1.✅" || echo 2."❌"

echo -e "\n4. /v2/ticker:"
curl -sk "https://forkex.life/v2/ticker?symbol=all" | jq -r 'length' 2>/dev/null && echo "1.✅" || echo "2.❌"

echo -e "\n5. WebSocket /stream:"
timeout 2 curl -sk -I -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
    wss://forkex.life/stream 2>&1 | grep -i "101\|upgrade" && echo "1.✅" || echo "2.❌"
