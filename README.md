# NIATSCIRCUIT Studio

Agent-driven PCB studio (Tauri + tscircuit), driven by your AI agent over MCP.
The app runs locally, exposes an HTTP MCP server; your agent connects through
the embedded stdio bridge. No code is ever invented: empty viewers mean the
local compile failed — see Troubleshooting.

📖 Français : [README.fr.md](README.fr.md) ·
Bridge details: [bridge/README.md](bridge/README.md)

Requires: app **≥ v0.1.1**, **Node ≥ 20** (runs the bridge).

## 1. Install

Download **v0.1.1+** from Releases for your OS and install:

| OS | File |
|---|---|
| Linux | `.deb` (`sudo dpkg -i …`) or `.AppImage` (`chmod +x … && ./…`) |
| macOS | `.dmg` → drag to Applications |
| Windows | `.msi` / `-setup.exe` → double-click |

Fallback (dev): `npm run tauri build` from sources (Rust + Node required).

## 2. Launch and check the boot

Open NIATSCIRCUIT Studio. In the bottom panel → **state** tab you should see:

- `Sidecar : prêt — http://127.0.0.1:<port>/mcp (pid …)`
- `Pont MCP : <absolute path to bridge.mjs>` + a copy button

If the viewers stay empty, open the **console** tab: the compile log tells you
exactly what failed (no silent fallback).

## 3. Connect your agent (canonical: embedded bridge, absolute path)

Copy the bridge path from the app (**state** tab → **Pont MCP** → copy), then
use it as `<BRIDGE>` below. The app must stay **open** (no headless mode:
a closed app answers `-32000`, by design). Never commit tokens: the bearer
token is ephemeral and lives only in the lockfile (see §5).

**OpenCode V2** (recommended):

```bash
opencode mcp add niatscircuit --global -- node "<BRIDGE>"
opencode mcp list   # ✓ niatscircuit connected
```

```jsonc
// or opencode.json(c): servers live under mcp.servers (never under mcp.<name>)
{ "mcp": { "servers": { "niatscircuit": {
  "type": "local", "command": ["node", "<BRIDGE>"], "protocol": "auto" } } } }
```

**Claude Code:**

```bash
claude mcp add --transport stdio niatscircuit -- node "<BRIDGE>"
claude mcp get niatscircuit
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.niatscircuit]
command = "node"
args = ["<BRIDGE>"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

**Cursor** (`.cursor/mcp.json`):

```json
{ "mcpServers": { "niatscircuit": { "command": "node", "args": ["<BRIDGE>"] } } }
```

## 4. Verify it works

1. App: shared compile logs `worker : N éléments, 0 erreur` (N > 0), all three
   viewers (Schematic/PCB/3D) non-empty.
2. Agent: `opencode mcp list` / `claude mcp list` shows connected; call one
   tool (e.g. read boot state / compile) → valid JSON, no `-32000`.

## 5. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Viewers empty, log `RÉSEAU REQUIS` | Old version: upgrade to ≥ v0.1.1 (offline-first local compile). |
| `Refused to evaluate … 'unsafe-eval'` | Old version: upgrade to ≥ v0.1.1 (CSP fix). |
| `File not found "main.tsx"` | Old version: upgrade to ≥ v0.1.1 (ENTRYPOINT fix). |
| `-32000` / « ouvre l'app » | The app is closed → open it (never headless, by design). |
| `401` / rejected token | Token rotated (regenerated on every launch) → stdio bridge recovers by itself; direct HTTP: re-read the token from the lockfile. |

Direct HTTP fallback (ephemeral lockfile token, current session only):

```bash
LOCK=$HOME/.cache/niatscircuit/mcp.json  # macOS: ~/Library/Caches/niatscircuit/mcp.json
URL=$(python3 -c "import json;print(json.load(open('$LOCK'))['url'])")
TOK=$(python3 -c "import json;print(json.load(open('$LOCK'))['token'])")
```

Lockfile paths: Linux `$XDG_CACHE_HOME/niatscircuit/mcp.json` (else `~/.cache/…`),
macOS `~/Library/Caches/niatscircuit/mcp.json`,
Windows `%LOCALAPPDATA%\niatscircuit\mcp.json`.
Override (tests, debug): `NIATSCIRCUIT_MCP_LOCK=/path/mcp.json`.
