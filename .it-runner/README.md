# BrainBuddy it-runner tasks

## `desktop-dev`

Starts the BrainBuddy development UI with renderer hot reload. On a host with
an active graphical session it opens Electron. On a headless Agentflow host it
starts a browser preview on the declared renderer port instead.

The task installs locked npm dependencies with `npm ci` only when
`node_modules/.bin/electron-vite` is missing. It then runs `npm run dev` and
waits for the renderer development server on `127.0.0.1:15174`. The task uses
`mise` with the Node version declared in
`tasks/desktop-dev/envs/000-defaults.env`, so it does not inherit an outdated
Node runtime from the it-runner host. If a graphical Agentflow-hosted runner is
running as root, this development-only task passes electron-vite's `--noSandbox`
flag. The browser fallback analyzes sample input locally in development mode.
The packaged application keeps its normal preload IPC and sandbox configuration;
do not use the development task with real secrets.

File-based controls:

```bash
echo "RESTART $(date +%s)" > .it-runner/states/desktop-dev.STATE
echo "STOP $(date +%s)" > .it-runner/states/desktop-dev.STATE
```

To add machine-local project overrides, copy
`.it-runner/env-templates/010-local.env.example` to
`.it-runner/envs/010-local.env`. The destination is intentionally ignored by
Git.
