echo "=== Создаем таблицу Affiliations ==="

# Находим контейнер с PostgreSQL
DB_CONTAINER=forkex-db

docker exec forkex-db psql -U admin -d hollaex << "EOF"
-- Создаем таблицу Affiliations если ее нет
CREATE TABLE IF NOT EXISTS "Affiliations" (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
    referer_id INTEGER NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
    earning_rate DECIMAL(10, 4) DEFAULT 0,
    code VARCHAR(50) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_user_referer UNIQUE (user_id, referer_id)
);

-- Создаем индексы
CREATE INDEX IF NOT EXISTS idx_affiliations_user_id ON "Affiliations"(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliations_referer_id ON "Affiliations"(referer_id);
CREATE INDEX IF NOT EXISTS idx_affiliations_code ON "Affiliations"(code);

-- Проверяем
SELECT tablename FROM pg_tables WHERE tablename = 'Affiliations';
\d "Affiliations"
EOF
