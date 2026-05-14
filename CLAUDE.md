# Reforger Control Panel — Project Summary

## What it is

Interactive Node.js CLI for managing an Arma Reforger dedicated server on Linux. One server at a time, no auto-restart. Uses `@inquirer/prompts` for arrow-key menus. Live at `/home/arma/control_panel/`.

## Architecture: layered config

Three levels of composition that get merged into a single config Reforger reads:

```
base.json           → infrastructure (ports, rcon, passwords, gameProperties defaults, operating defaults)
modpacks/*.json     → reusable mod bundles ({description, mods: [...]})
servers/*.json      → per-server (name, scenarioId, modpacks: [], optional mods/overrides)
```

Resolution pipeline (in `loadServers`):

1. `deepMerge(base, server)` — objects merge recursively, arrays replace entirely (no special cases)
2. `validateMerged()` — checks name, scenarioId, `serverMinGrassDistance >= 50`
3. `expandModpacks()` — resolves `game.modpacks: ["coe2","ace"]` into flat `game.mods`, appends explicit `game.mods`, dedups by `modId` with last-wins, deletes the `modpacks` field
4. Compiled JSON written to `compiled/<server-name>.json` (overwritten each start), fed to Reforger via `-config=`

## Runtime layout

```
control_panel/
├── reforger-ctl.js     # the tool
├── package.json        # only dep: @inquirer/prompts
├── base.json
├── modpacks/{coe2,ace,escapists}.json
├── servers/{coe2_arland,escapists_kolguyev}.json
├── compiled/           # auto-generated, mirrors server filenames
├── profiles/<server>/  # per-server -profile= dir (saves, crash dumps, rcon state)
├── logs/<server>_<timestamp>.log
└── state/server.json   # tracks pid, serverFile, compiledFile, profileDir, startedAt
```

## Server spawn (`startServer`)

* Detached child process, `child.unref()`, stdio piped to log file
* Args: `-config=<compiled> -profile=<profiles/name> -maxFPS=60 -logFile=<log> -noLauncher -headless`
* 1.2s liveness check via `process.kill(pid, 0)`; if dead, fail with log path
* `disableCrashReporter` lives in `base.json` `operating` block, not CLI flag

## Stop (`stopServer`)

SIGTERM, poll `isAlive` every 500ms for 15s, then SIGKILL fallback. Always clears state file.

## State tracking

`state/server.json` written on start, read on every menu refresh, auto-deleted when `process.kill(pid, 0)` shows the pid is gone. So stale state self-heals.

## UI features

* Animated cyan→blue gradient ASCII banner on startup (xterm 256-color codes 51/45/39/33/27)
* `Spinner` class with braille frames (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), 80ms interval, methods: `start/update/succeed/fail/warn`
* `pulse()` effect on the green `●` running indicator (only on first view, not refreshes)
* Cursor hide/show with SIGINT/SIGTERM handlers to restore on Ctrl+C
* Menu summary line per server: `Name · Scenario · 64p · :2302 · 4 mods (2 packs) (file.json)`
* Bad configs (parse errors, missing fields, unknown modpacks, grass < 50) shown greyed-out with inline error

## Idle vs running menu

* Idle: shows base summary line (`base · :2302 game · :17777 a2s · :19999 rcon · 64p default`), then arrow-key picker of servers
* Running: shows server name + uptime + pid + paths to compiled/profile/log; actions: Stop, Tail log (Ctrl+C exits tail, not script), Refresh, Quit (leaves server alive)

## Reforger binary path

`/home/arma/reforger/reforger/ArmaReforgerServer` — hardcoded as `REFORGER_BIN` constant near top of script.

## Known design decisions worth preserving

* Arrays always replace in merge — no special case for modpacks. Want a common pack on every server? List it explicitly per-server.
* Last-wins mod dedup — pack order in `game.modpacks` matters; explicit `game.mods` overrides packs (use for version pinning).
* Compiled files keep source filename (`coe2_arland.json` → `compiled/coe2_arland.json`), overwritten each start. Log filenames are timestamped for run history.
* Profile dir name = server file basename (`coe2_arland.json` → `profiles/coe2_arland/`). Wipe saves by deleting the dir while stopped.
* One server at a time, by design. Detached spawn means quitting the tool leaves the server running.

## What could still be added

* `.gitignore` for `profiles/`, `compiled/`, `logs/`, `state/`
* "View modpack contents" menu item
* Live uptime counter in running header
* RCON command interface
