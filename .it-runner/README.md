# BrainBuddy it-runner tasks

## `desktop-dev`

Starts the Electron development app with renderer hot reload. The host running
it-runner must have an active graphical desktop session available to Electron.

The task installs locked npm dependencies with `npm ci` only when
`node_modules/.bin/electron-vite` is missing. It then runs `npm run dev` and
waits for the renderer development server on `127.0.0.1:5173`.

File-based controls:

```bash
echo "RESTART $(date +%s)" > .it-runner/states/desktop-dev.STATE
echo "STOP $(date +%s)" > .it-runner/states/desktop-dev.STATE
```

To add machine-local project overrides, copy
`.it-runner/env-templates/010-local.env.example` to
`.it-runner/envs/010-local.env`. The destination is intentionally ignored by
Git.
