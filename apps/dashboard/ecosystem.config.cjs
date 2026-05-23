// Same ecosystem on Mac and VPS. Paths use __dirname so it survives both.
// Node interpreter falls back to whatever `node` resolves to in $PATH.
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'asst-dashboard',
      cwd: __dirname,
      script: path.join(__dirname, 'node_modules/next/dist/bin/next'),
      args: `start -p ${process.env.PORT || '4100'}`,
      env: { NODE_ENV: 'production', PORT: process.env.PORT || '4100' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
