# NIATSCIRCUIT Studio

Studio PCB agentique (Tauri + tscircuit), piloté par ton agent IA via MCP.
L'app tourne en local, expose un serveur MCP HTTP ; ton agent s'y connecte
via le pont stdio embarqué. Aucun code inventé : des viewers vides signifient
que la compile locale a échoué — voir Dépannage.

📖 English: [README.md](README.md) ·
Détails du pont : [bridge/README.md](bridge/README.md)

Requis : app **≥ v0.1.1**, **Node ≥ 20** (exécute le pont).

## 1. Installer

Télécharge la **v0.1.1+** depuis les Releases pour ton OS et installe :

| OS | Fichier |
|---|---|
| Linux | `.deb` (`sudo dpkg -i …`) ou `.AppImage` (`chmod +x … && ./…`) |
| macOS | `.dmg` → glisser vers Applications |
| Windows | `.msi` / `-setup.exe` → double-clic |

Repli (dev) : `npm run tauri build` depuis les sources (Rust + Node requis).

## 2. Lancer et vérifier le boot

Ouvre NIATSCIRCUIT Studio. Dans le panneau bas → onglet **state**, tu dois voir :

- `Sidecar : prêt — http://127.0.0.1:<port>/mcp (pid …)`
- `Pont MCP : <chemin absolu vers bridge.mjs>` + bouton copier

Si les viewers restent vides, ouvre l'onglet **console** : le log de compile
dit exactement ce qui a échoué (aucun repli silencieux).

## 3. Brancher ton agent (canonique : pont embarqué, chemin absolu)

Copie le chemin du pont depuis l'app (onglet **state** → **Pont MCP** →
copier), puis utilise-le comme `<BRIDGE>` ci-dessous. L'app doit rester
**ouverte** (pas de headless : app fermée = `-32000`, voulu). Ne commite
jamais de token : le bearer est éphémère et vit uniquement dans le lockfile (§5).

**OpenCode V2** (recommandé) :

```bash
opencode mcp add niatscircuit --global -- node "<BRIDGE>"
opencode mcp list   # ✓ niatscircuit connected
```

```jsonc
// ou opencode.json(c) : les serveurs vivent sous mcp.servers (jamais sous mcp.<nom>)
{ "mcp": { "servers": { "niatscircuit": {
  "type": "local", "command": ["node", "<BRIDGE>"], "protocol": "auto" } } } }
```

**Claude Code :**

```bash
claude mcp add --transport stdio niatscircuit -- node "<BRIDGE>"
claude mcp get niatscircuit
```

**Codex** (`~/.codex/config.toml`) :

```toml
[mcp_servers.niatscircuit]
command = "node"
args = ["<BRIDGE>"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

**Cursor** (`.cursor/mcp.json`) :

```json
{ "mcpServers": { "niatscircuit": { "command": "node", "args": ["<BRIDGE>"] } } }
```

## 4. Vérifier que ça marche

1. App : la compile partagée logue `worker : N éléments, 0 erreur` (N > 0),
   les trois viewers (Schéma/PCB/3D) sont remplis.
2. Agent : `opencode mcp list` / `claude mcp list` = connecté ; appelle un
   outil (ex. lecture boot / compile) → JSON valide, pas de `-32000`.

## 5. Dépannage

| Symptôme | Cause → fix |
|---|---|
| Viewers vides, log `RÉSEAU REQUIS` | Vieille version : passe en ≥ v0.1.1 (compile locale offline-first). |
| `Refused to evaluate … 'unsafe-eval'` | Vieille version : passe en ≥ v0.1.1 (fix CSP). |
| `File not found "main.tsx"` | Vieille version : passe en ≥ v0.1.1 (fix ENTRYPOINT). |
| `-32000` / « ouvre l'app » | L'app est fermée → ouvre-la (jamais de headless, voulu). |
| `401` / token rejeté | Token tourné (régénéré à chaque lancement) → le pont stdio récupère seul ; HTTP directe : relis le token du lockfile. |

Secours HTTP directe (token éphémère du lockfile, session courante uniquement) :

```bash
LOCK=$HOME/.cache/niatscircuit/mcp.json  # macOS : ~/Library/Caches/niatscircuit/mcp.json
URL=$(python3 -c "import json;print(json.load(open('$LOCK'))['url'])")
TOK=$(python3 -c "import json;print(json.load(open('$LOCK'))['token'])")
```

Lockfile : Linux `$XDG_CACHE_HOME/niatscircuit/mcp.json` (sinon `~/.cache/…`),
macOS `~/Library/Caches/niatscircuit/mcp.json`,
Windows `%LOCALAPPDATA%\niatscircuit\mcp.json`.
Override (tests, debug) : `NIATSCIRCUIT_MCP_LOCK=/chemin/mcp.json`.
