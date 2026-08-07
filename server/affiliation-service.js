const express = require('express');
const app = express();

app.get('/v2/user/affiliation', (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    
    console.log(`[AFFILIATION] Request: page=${page}, limit=${limit}`);
    
    res.json({
        success: true,
        data: [],
        count: 0,
        page: page,
        limit: limit,
        is_remaining: false
    });
});

const PORT = 10013;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Affiliation service on port ${PORT}`);
});
