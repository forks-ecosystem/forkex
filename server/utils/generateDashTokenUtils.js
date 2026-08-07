const jwt = require('jsonwebtoken');
//const { getKitConfig } = require('./kit');
//const { getKitConfig } = require('./hollaex-tools-lib/tools/common');

const generateDashTokenUtils = async ({
    user_id = 1,
    email = 'broker1@taxi-x.org',
    role = 'admin'
} = {}) => {

    //const kit = getKitConfig();

    const payload = {
        sub: {
            id: user_id,
            email,
            networkId: 1,
            role
        },
        scopes: ['admin'],
        iss: 'ForkEX',
        iat: Math.floor(Date.now() / 1000)
    };

    const secret =
        process.env.JWT_SECRET ||
        'supersecret123';

    const token = jwt.sign(payload, secret, {
        expiresIn: '7d'
    });

    return { token };
};

module.exports = {
    generateDashTokenUtils
};
