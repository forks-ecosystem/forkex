echo "=== Тестируем affiliation endpoint ==="

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOnsiaWQiOjcsImVtYWlsIjoiaXhiYXNlNUBnbWFpbC5jb20iLCJuZXR3b3JrSWQiOjI4MzMxNywibGFuZyI6ImVuIiwicm9sZSI6InVzZXIifSwic2NvcGVzIjpbInVzZXIiXSwiaXAiOiIxODUuMjUzLjIxOS41MSIsImlzcyI6IkZvcmtFWCIsImlhdCI6MTc2NzMyMTkzNCwiZXhwIjoxNzc1MDk3OTM0fQ.Q75lbiKtakbpF0BCjQufKMNe1FRyszar9PVRVH3o6B4"

curl -sk -H "Authorization: Bearer $TOKEN" \
    -w "HTTP статус: %{http_code}\n" \
    -o /tmp/affiliation-result.json \
    "https://forkex.life/v2/user/affiliation?limit=5&page=1"

echo "Ответ:"
cat /tmp/affiliation-result.json | jq . 2>/dev/null || cat /tmp/affiliation-result.json
