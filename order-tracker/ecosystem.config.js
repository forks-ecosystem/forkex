module.exports = {
  apps: [{
    name: 'order-tracker',
    script: 'index.js',
    cwd: '/app/forkex/order-tracker',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_restarts: 10,
    restart_delay: 5000,
    env: { NODE_ENV: 'production' }
  }]
};
