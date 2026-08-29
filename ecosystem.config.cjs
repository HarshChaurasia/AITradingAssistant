/**
 * PM2 process definitions for an unattended run.
 *
 * The two long-lived processes are the Node API (which owns the scheduler)
 * and the Python MT5 bridge. Both restart on crash; neither is a dev server.
 *
 * The Vite dev client is deliberately absent - it is a development tool, not
 * something to leave running for a fortnight. Serve `client/dist` from the
 * API or a static host instead.
 *
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 status
 *   npx pm2 logs
 *   npx pm2 stop all
 *
 * To survive a reboot on Windows, see docs/DEPLOYMENT.md - PM2's `startup`
 * command is Linux-only, so Windows uses a Task Scheduler entry that runs
 * `pm2 resurrect`.
 */
module.exports = {
  apps: [
    {
      name: 'trading-api',
      script: 'src/index.js',
      cwd: './server',
      instances: 1,
      autorestart: true,
      // A crash loop means something is genuinely broken; restarting 200 times
      // a second just buries the error in the log.
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '500M',
      out_file: '../logs/api.out.log',
      error_file: '../logs/api.err.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'trading-bridge',
      script: 'bridge/venv/Scripts/python.exe',
      args: 'bridge/app.py',
      interpreter: 'none',
      cwd: '.',
      instances: 1,
      autorestart: true,
      // The bridge blocks for ~70s connecting to MT5 before it serves, so a
      // shorter min_uptime would read a slow start as a crash loop.
      min_uptime: '120s',
      max_restarts: 10,
      restart_delay: 15000,
      out_file: './logs/bridge.out.log',
      error_file: './logs/bridge.err.log',
      merge_logs: true,
      time: true
    }
  ]
};
