// helpers/user.js
const redis = require('../db/redis');

async function getApiKeyForUser(userId) {
    return await redis.getAsync(`hollaex:user-api-key:${userId}`);
}

module.exports = { getApiKeyForUser };

/*
 GET hollaex:user-api-key:2
"57f5c92f5346dea2606d0622890a9a220744b32b"
GET hollaex:user-api-secret:2
*/