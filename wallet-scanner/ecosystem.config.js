module.exports = {
    apps: [{
        name: 'wallet-scanner',
        script: '/app/forkex/wallet-scanner/index.js',
        interpreter: '/root/.nvm/versions/node/v23.11.0/bin/node',
        max_restarts: 10,
        restart_delay: 5000,
        env: {
            NODE_PATH: '/app/forkex/wallet-scanner/node_modules',
        },
    }],
};
