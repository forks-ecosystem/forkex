module.exports = {
    getAffiliation: (req, res) => {
        console.log('Affiliation endpoint called');
        res.json({
            success: true,
            data: [],
            count: 0,
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 20,
            is_remaining: false
        });
    }
};
