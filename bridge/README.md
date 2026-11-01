# @nia-tscircuit/mcp-bridge — thin bridge stdio ↔ HTTP (ticket #11)

Adaptateur fin (~130 lignes, zéro dépendance, Node ≥ 20) entre clients MCP
stdio (opencode, claude code, codex, cursor) et le studio : le serveur HTTP
local canonique (`pcb-mcp`, stateless 2026-07-28 + fallback legacy) reste
l'unique état partagé, le bridge ne fait que relayer.

- `stdin` = MCP pur (lignes JSON-RPC `\n`, sans newline embarquée).
- Chaque ligne ⇒ `POST <url>` avec `Content-Type` / `Accept` /
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` /
  `Authorization: Bearer <token du lockfile>`.
- Réponse JSON directe ou SSE (`data:`) ⇒ une ligne sur `stdout`.
- Logs ⇒ `stderr` préfixé `[bridge]` uniquement. `stdout` jamais polluée.
- **Jamais de headless** : lockfile absent/invalide ou probe KO ⇒ erreur
  JSON-RPC `-32000` « ouvre l'app » sur chaque requête (notifications :
  aucune réponse, par spec). Pas de process fantôme.
- Multi-client gratuit : N bridges partagent l'URL du lockfile (même état,
  file côté serveur, `id` JSON-RPC corrélés).
- Token tourné (app relancée) : sur `401`, le lockfile est relu une fois et
  la requête rejouée.

## Lockfile

Même sémantique que `dirs::cache_dir` côté Tauri :

| OS      | Fichier                                              |
| ------- | ---------------------------------------------------- |
| Linux   | `$XDG_CACHE_HOME/niatscircuit/mcp.json` sinon `~/.cache/...` |
| macOS   | `~/Library/Caches/niatscircuit/mcp.json`            |
| Windows | `%LOCALAPPDATA%\niatscircuit\mcp.json`              |

Override (tests, debug) : `NIATSCIRCUIT_MCP_LOCK=/chemin/mcp.json`.

## Configs clients (défaut : bridge stdio)

```bash
# claude code
claude mcp add --transport stdio niatscircuit -- node /chemin/vers/bridge/bridge.mjs
# variante publiée npm :
claude mcp add --transport stdio niatscircuit -- npx -y @nia-tscircuit/mcp-bridge
```

```jsonc
// opencode (opencode.json)
{ "mcp": { "niatscircuit": { "type": "local",
  "command": ["node", "bridge/bridge.mjs"] } } }
```

```toml
# codex (~/.codex/config.toml)
[mcp_servers.niatscircuit]
command = "node"
args = ["bridge/bridge.mjs"]  # chemin absolu recommandé
startup_timeout_sec = 10
tool_timeout_sec = 60
```

```jsonc
// cursor (.cursor/mcp.json)
{ "mcpServers": { "niatscircuit": {
  "command": "node", "args": ["bridge/bridge.mjs"] } } }
```

## HTTP directe (secours, token éphémère du lockfile)

```bash
LOCK=$HOME/.cache/niatscircuit/mcp.json  # macOS: ~/Library/Caches/niatscircuit/mcp.json
URL=$(python3 -c "import json;print(json.load(open('$LOCK'))['url'])")
TOK=$(python3 -c "import json;print(json.load(open('$LOCK'))['token'])")
# opencode : { "type": "remote", "url": "$URL",
#   "headers": { "Authorization": "Bearer $TOK" }, "oauth": false }
```

## Tests

```bash
npm test  # node --test test/*.test.mjs (S1–S5, stub HTTP fidèle + 2 bridges)
```
