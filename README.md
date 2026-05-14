# reforger-ctl

Interactive CLI for starting/stopping one Arma Reforger server at a time, with a layered config system.

## Layout

```
/home/arma/control_panel/
├── reforger-ctl.js
├── package.json
├── base.json              ← shared: ports, rcon, passwords, defaults
├── modpacks/              ← reusable mod bundles
│   ├── coe2.json
│   ├── ace.json
│   └── escapists.json
├── servers/
│   ├── coe2_arland.json   ← per-server: name, scenario, modpacks, overrides
│   └── escapists_kolguyev.json
├── compiled/              ← auto-generated merged configs (don't edit)
├── profiles/              ← per-server runtime data — saves, crash dumps, rcon state
│   ├── coe2_arland/
│   └── escapists_kolguyev/
├── logs/                  ← per-run logs, timestamped
└── state/                 ← live server PID tracking
```

## Modpacks

Reusable mod bundles. Each file in `modpacks/` is referenced by its filename (without `.json`):

```json
// modpacks/coe2.json
{
  "description": "Combat Operations Everon 2 scenario + Kex framework",
  "mods": [
    { "modId": "60926835F4A7B0CA", "name": "COE2",              "version": "2.3.1"  },
    { "modId": "5ED61DC0AFE17E8E", "name": "Kex Scenario Core", "version": "0.4.27" }
  ]
}
```

Server files reference packs by name in `game.modpacks`, optionally adding explicit `game.mods` for per-server pins or extras:

```json
// servers/coe2_arland_with_rhs.json
{
  "game": {
    "name": "1Tac · COE2 Arland (RHS)",
    "scenarioId": "{F239FD0036BD2C1E}Missions/COE2_Arland.conf",
    "modpacks": ["coe2", "ace", "rhs"],
    "mods": [
      { "modId": "60926835F4A7B0CA", "name": "COE2", "version": "2.4.0" }
    ]
  }
}
```

**Resolution rules:**
1. Packs are expanded in the order listed in `modpacks`.
2. Explicit `mods` entries are appended after pack mods.
3. Dedup by `modId`, **last-wins**. So:
   - If two packs include the same `modId`, the later one wins.
   - Explicit `mods` always win over pack entries (use this to pin a specific version per-server).
4. After expansion, the compiled config has a flat `mods: [...]` array — `modpacks` is a tool-level concept; Reforger never sees it.

If a server references a modpack that doesn't exist, the menu greys it out with `⚠ unknown modpack: rhs`.

## Profile directories — where your saves live

Each server gets its own `profiles/<name>/` dir, passed to Reforger via `-profile=`. This is where:
- Persistence saves accumulate (matters for scenarios with player progression like COE2)
- Crash dumps land
- RCON state is cached
- Any per-server runtime files Reforger writes

The dir is named after the server JSON filename (e.g. `servers/coe2_arland.json` → `profiles/coe2_arland/`). It's auto-created on first start. To wipe a server's saves and start fresh, delete the matching profile dir while the server is stopped.

## How configs merge

When you start a server, the tool deep-merges `base.json` + the chosen `servers/*.json` and writes the result to `compiled/<server>.json`, then hands that file to Reforger.

**Rules:**
- Objects merge recursively (e.g. `game.gameProperties` from base + the per-server override are combined field-by-field).
- Arrays replace entirely. If a server file defines `mods`, that's the full list — no concat with base. Same for `supportedPlatforms`, `admins`, etc.
- Anything not in the server file falls through to base.

The compiled JSON is human-readable and committed to `compiled/` after every start, so you can always see exactly what was sent to the server.

## Per-server config — what to put in it

At minimum:
- `game.name` — appears in the server browser
- `game.scenarioId` — `{GUID}Missions/Scenario.conf`
- `game.mods` — full mod list for this scenario

Optionally override anything else from base, e.g. bumping `gameProperties.serverMinGrassDistance` for one scenario, or running with `maxPlayers: 32` on a smaller mission. Just nest it the same way it's nested in base.

## Setup

```bash
cd /home/arma/control_panel
npm install
node reforger-ctl.js
```

## Tweaks

In `reforger-ctl.js`:
```js
const REFORGER_DIR = '/home/arma/reforger/reforger';
const REFORGER_BIN = join(REFORGER_DIR, 'ArmaReforgerServer');
```

In `base.json`:
- **Change `rcon.password`** before running publicly.
- Set `game.password` to `""` for a public server.
- Adjust `operating.aiLimit` based on what your CPU handles.

## Ports to open

- `2302/udp` — game (`bindPort`)
- `17777/udp` — A2S queries (`a2s.port`)
- `19999/udp` — RCON (`rcon.port`)

## Notes

- One server at a time, no auto-restart — by design.
- Server is detached; quitting reforger-ctl leaves the server alive. Re-launch the tool any time to manage it.
- Compiled files in `compiled/` are overwritten each start (same name as the source). Log files in `logs/` are timestamped per run.
- Bad JSON or missing required fields in a server config shows up in the menu greyed out with the error inline.
