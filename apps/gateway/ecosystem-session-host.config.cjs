// A SEPARATE ecosystem file from the gateway's, and that is the whole point.
//
// `pm2 startOrRestart <file>` restarts every app in the file it is given. If
// the session host lived in ecosystem.config.cjs beside the gateway, then the
// command that deploys a gateway change — which is exactly the command the
// gateway's own startup check tells you to run — would restart the host too,
// end every child it is holding, and undo the one property this process exists
// for. Two files, two lifecycles.
//
// Deploying a gateway change:   pm2 startOrRestart apps/gateway/ecosystem.config.cjs && pm2 save
// Deploying a host change:      pm2 startOrRestart apps/gateway/ecosystem-session-host.config.cjs && pm2 save
//                               ↑ ends every live session on the machine. Treat it like a gateway
//                                 restart used to be treated: ask first, batch it, expect to pay.
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'hermit-ui-session-host',
      cwd: __dirname,
      script: path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      args: 'src/session-host/main.ts',
      env: {
        NODE_ENV: 'production',
        // Same reason as the gateway's: pm2's daemon PATH often lacks
        // ~/.local/bin, and this process is the one that now spawns `claude`.
        PATH: (() => {
          const os = require('os');
          const home = os.homedir();
          const extras =
            process.platform === 'darwin'
              ? [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']
              : [`${home}/.local/bin`, '/usr/local/bin', `${home}/.npm-global/bin`, '/snap/bin'];
          const base = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
          const have = new Set(base.split(':'));
          return [...extras.filter((p) => !have.has(p)), base].join(':');
        })(),
      },
      // Signal this process only. Its children are the entire point of it; a
      // treekill here would be indistinguishable from not having it at all.
      treekill: false,
      // It ends its children on the way down (nothing can adopt their stdio),
      // and each gets stdin closed first so the CLI writes its transcript out.
      kill_timeout: 10_000,
      autorestart: true,
      max_restarts: 50,
      exp_backoff_restart_delay: 5000,
      out_file: path.join(__dirname, 'logs/session-host-out.log'),
      error_file: path.join(__dirname, 'logs/session-host-err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
