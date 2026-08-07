cd /opt/forkex/server/api

echo "=== Добавляем метод getAffiliation в user controller ==="

# Проверяем есть ли уже метод
if grep -q "getAffiliation" controllers/user.js; then
    echo "Метод getAffiliation уже существует"
else
    echo "Добавляем метод getAffiliation..."
    
    # Найдем где добавить метод (перед последней закрывающей скобкой)
    LINE=$(grep -n "^}" controllers/user.js | tail -1 | cut -d: -f1)
    
    if [ -n "$LINE" ]; then
        # Добавляем метод перед последней }
        sed -i "${LINE}i\\
\\
// GET /user/affiliation - get user referrals\\
exports.getAffiliation = (req, res) => {\\
    try {\\
        const limit = parseInt(req.query.limit) || 20;\\
        const page = parseInt(req.query.page) || 1;\\
        \\
        console.log('[USER] Affiliation request from user:', req.user?.id, { page, limit });\\
        \\
        // ЗАГЛУШКА - возвращаем пустые данные\\
        // В будущем можно реализовать запрос к БД\\
        return res.json({\\
            success: true,\\
            data: [],\\
            count: 0,\\
            page: page,\\
            limit: limit,\\
            is_remaining: false\\
        });\\
    } catch (error) {\\
        console.error('[USER] Affiliation error:', error);\\
        return res.status(400).json({\\
            success: false,\\
            message: error.message || 'Error fetching affiliation data'\\
        });\\
    }\\
};" controllers/user.js
        
        echo "Метод добавлен в controllers/user.js"
    else
        echo "Не удалось найти место для добавления метода"
    fi
fi
