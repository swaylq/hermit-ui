const path = require('path');

module.exports = {
  apps: [
    {
      name: 'asst-gateway',
      cwd: __dirname,
      script: path.join(__dirname, 'node_modules/.bin/tsx'),
      args: 'src/index.ts',
      env: {
        DASHBOARD_URL: 'https://dash.swaylab.ai',
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
