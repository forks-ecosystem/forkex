module.exports = {
  apps: [{
    name: 'forkex-market-maker',
    script: '/app/forkex/market-maker/index.js',
    interpreter: '/root/.nvm/versions/node/v23.11.0/bin/node',
    watch: false,
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
