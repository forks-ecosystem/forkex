const express = require('express');
const app = express();

app.get('/v2/user/affiliation', (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    
    console.log(`[AFFILIATION SERVICE] Request: page=${page}, limit=${limit}`);
    
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
app.listen(PORT, () => {
    console.log(`Affiliation service running on port ${PORT}`);
});