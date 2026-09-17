module.exports = {
  apps: [
    {
      name: 'zenatlas-api',
      script: 'src/main.ts',
      interpreter: 'node',
      interpreter_args: '--env-file-if-exists=.env --import tsx',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,
      watch: false,
    },
    {
      name: 'zenatlas-worker',
      script: 'src/worker-main.ts',
      interpreter: 'node',
      interpreter_args: '--env-file-if-exists=.env --import tsx',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,
      watch: false,
    },
    {
      // Checks the services, engines, models, APIs and packages above depend on (docs/WATCHDOG.md). It restarts
      // itself when its own code changes, and only reports when the others need a restart.
      name: 'zenatlas-watchdog',
      script: 'src/watchdog-main.ts',
      interpreter: 'node',
      interpreter_args: '--env-file-if-exists=.env --import tsx',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      watch: false,
    },
  ],
};
