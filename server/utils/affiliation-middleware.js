module.exports = function(req, res, next) {
    if (req.originalUrl.includes('/v2/user/affiliation') && req.method === 'GET') {
        console.log('[AFFILIATION] Intercepted:', req.originalUrl);
        
        const limit = parseInt(req.query.limit) || 20;
        const page = parseInt(req.query.page) || 1;
        
        // Возвращаем заглушку
        return res.json({
            success: true,
            data: [],
            count: 0,
            page: page,
            limit: limit,
            is_remaining: false
        });
    }
    next();
};