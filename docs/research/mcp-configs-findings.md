# Config MCP multi-agents — findings (issue #22)

Statut : recherche wayfinder AFK. Chaque claim cite sa source (URL ou chemin).
Question tranchée : syntaxe exacte et vérifiée pour brancher chaque agent sur le
studio via le bridge stdio canonique (`bridge/bridge.mjs`, lockfile + Bearer,
HTTP directe en secours). Le prototype consommera ce document.

Rappel socle (déjà tranché, cf `docs/research/transport-auth-mcp.md` et
`bridge/README.md:1-32`) : serveur HTTP local canonique (`pcb-mcp`, stateless
2026-07-28 + fallback legacy), thin bridge stdio ~120 lignes zéro-dépendance
(Node ≥ 20), lockfile `{url, token, protocolVersion}` écrit par l'app au boot,
jamais de headless (app fermée ⇒ JSON-RPC `-32000` « ouvre l'app »).

## 0. Verdict — stdio canonique pour les 4 agents, HTTP en secours

| Agent | Fichier / commande | Forme canonique (bridge stdio) |
|---|---|---|
| OpenCode V2 | `opencode.json(c)` sous `mcp.servers` ou `opencode mcp add --global` | `"type": "local", "command": ["node", "/ABS/bridge/bridge.mjs"]` |
| Claude Code | `claude mcp add --transport stdio` | `claude mcp add --transport stdio niatscircuit -- node /ABS/bridge/bridge.mjs` |
| Codex | `~/.codex/config.toml` (ou `.codex/config.toml` projet) | `[mcp_servers.niatscircuit]` + `command = "node"`, `args = ["/ABS/bridge/bridge.mjs"]` |
| Cursor | `.cursor/mcp.json` (projet) ou `~/.cursor/mcp.json` (global) | `{ "mcpServers": { "niatscircuit": { "command": "node", "args": ["/ABS/bridge.mjs"] } } }` |

Règles communes (4 agents) :
- **Chemin absolu** vers `bridge.mjs` (les chemins relatifs se résolvent depuis
  le cwd de chaque agent, donc fragiles).
  Sources : Codex exige cwd/commande explicite
  (`https://developers.openai.com/codex/extend/mcp/`, § STDIO `cwd` optionnel) ;
  Cursor `${workspaceFolder}` existe justement pour ancrer les chemins
  (`https://cursor.com/docs/context/mcp`, § Config interpolation).
- **Node ≥ 20** sur le PATH (bridge zéro-dépendance, shebang `#!/usr/bin/env node`).
  Source : `bridge/bridge.mjs:1-2`, `bridge/README.md:5-6`.
- **Ne jamais commiter le token** : il est éphémère (régénéré à chaque lancement
  de l'app) et vit uniquement dans le lockfile.
  Source : lockfile live `~/.cache/niatscircuit/mcp.json` (`{port, token, pid,
  startedAt, url, protocolVersion}`) ; `bridge/lib.mjs:116-143` (validation :
  url `http://127.0.0.1:<port>/mcp` uniquement).

## 1. OpenCode V2 — `mcp.servers` (pas `mcp.<nom>`)

Source : `https://opencode.ai/v2/docs/mcp-servers` (vérifié 2026-11-02).

- V2 ne place **jamais** les serveurs directement sous `mcp` : la clé est
  `mcp.servers.<nom>`. L'ancienne forme `mcp.niatscircuit.type = "local"`
  (encore visible en `bridge/README.md:44-47`) est de la **syntaxe V1 périmée**.
- Schéma local : `{ "type": "local", "command": ["<exe>", "<args...>"] }`,
  `command` = exécutable suivi de ses arguments (tableau, pas une chaîne).
- Champs optionnels utiles : `cwd`, `environment` (avec substitution
  `{env:NAME}`, jamais de `$NAME` en JSON), `disabled`, `timeout`, `protocol`
  (`legacy` par défaut, `auto` pour sonder 2026-07-28).
- CLI : `opencode mcp add <nom> -- <commande> [args...]` ; `--global` pour un
  usage perso multi-projets, sans `--global` pour le projet courant.
  Vérification : `opencode mcp list` (`✓ <nom> connected` attendu).

Copié-collable (adapter `/ABS` au checkout) :

```bash
# global (recommandé pour un usage perso)
opencode mcp add niatscircuit --global -- node /ABS/NIATSCIRCUIT/bridge/bridge.mjs
opencode mcp list   # ✓ niatscircuit connected (app ouverte requise)
```

```jsonc
// opencode.json(c) — projet ou ~/.config/opencode/opencode.json(c)
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "niatscircuit": {
        "type": "local",
        "command": ["node", "/ABS/NIATSCIRCUIT/bridge/bridge.mjs"],
        "protocol": "auto"
      }
    }
  }
}
```

Note : `opencode.json` à la racine du repo est déjà en forme V2
(`mcp.servers.niatscircuit`, `protocol: auto`) — c'est `bridge/README.md:44-47`
qui est périmé et que le prototype corrigera.

Secours HTTP directe (token éphémère, ne pas commiter) :

```bash
LOCK=$HOME/.cache/niatscircuit/mcp.json  # macOS: ~/Library/Caches/niatscircuit/mcp.json
URL=$(python3 -c "import json;print(json.load(open('$LOCK'))['url'])")
TOK=$(python3 -c "import json;print(json.load(open('$LOCK'))['token'])")
opencode mcp add niatscircuit-http --global --url "$URL" --header "Authorization: Bearer $TOK"
```

Source forme remote + `oauth: false` + `headers` :
`https://opencode.ai/v2/docs/mcp-servers` (§ Remote : `type: "remote"`, `url`
absolue, `oauth: false` quand pas d'OAuth, secrets via `{env:...}`).

## 2. Claude Code — `claude mcp add --transport stdio`

Source : `https://code.claude.com/docs/en/mcp.md` (vérifié 2026-11-02).

- Stdio : `claude mcp add [options] <nom> -- <commande> [args...]`. Le `--`
  sépare les options de `claude` (dont `--transport`, `--env`, `--scope`) de la
  commande du serveur ; tout ce qui suit `--` est passé tel quel au serveur.
- `--env KEY=valeur` (répétable) se place **entre** le nom et `--`. Ici aucun
  `--env` n'est requis (le bridge lit seul le lockfile).
- Scopes : `-s local` (défaut, projet courant) | `project` (partagé via
  `.mcp.json`) | `user` (tous les projets).
- Gestion : `claude mcp list`, `claude mcp get <nom>`, `claude mcp remove <nom>`,
  panneau `/mcp` dans le TUI.

Copié-collable :

```bash
claude mcp add --transport stdio niatscircuit -- node /ABS/NIATSCIRCUIT/bridge/bridge.mjs
# variante publiée npm :
claude mcp add --transport stdio niatscircuit -- npx -y @nia-tscircuit/mcp-bridge
claude mcp get niatscircuit   # vérification connexion (app ouverte requise)
```

Secours HTTP directe :

```bash
claude mcp add --transport http niatscircuit-http "$URL" --header "Authorization: Bearer $TOK"
```

Source : même page, § Option 1 (syntaxe `--transport http <nom> <url>` +
`--header`, alias `streamable-http` accepté en JSON).

## 3. Codex — `[mcp_servers.niatscircuit]` dans `config.toml`

Source : `https://developers.openai.com/codex/extend/mcp/` + référence
`https://developers.openai.com/codex/config-file/config-reference`
(vérifié 2026-11-02).

- Fichier `~/.codex/config.toml` (global, partagé avec l'app desktop ChatGPT,
  le CLI Codex et l'extension IDE) ou `.codex/config.toml` (projet, projets de
  confiance uniquement).
- Chaque serveur = table `[mcp_servers.<nom>]`. Champs stdio : `command`
  (requis), `args`, `env` (table), `env_vars`, `cwd`, `startup_timeout_sec`
  (défaut 10), `tool_timeout_sec` (défaut 60), `enabled`.
- Champs HTTP : `url` (requis), `bearer_token_env_var` (nom d'une variable
  d'environnement — préféré au token en dur), `http_headers`,
  `env_http_headers`, `enabled_tools` / `disabled_tools`.

Copié-collable (`~/.codex/config.toml`, chemin absolu recommandé) :

```toml
[mcp_servers.niatscircuit]
command = "node"
args = ["/ABS/NIATSCIRCUIT/bridge/bridge.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Secours HTTP directe (ne pas écrire le token en dur ; passer par l'env) :

```toml
[mcp_servers.niatscircuit_http]
url = "http://127.0.0.1:PORT/mcp"   # recopier depuis le lockfile
bearer_token_env_var = "NIATSCIRCUIT_MCP_TOKEN"
```

```bash
export NIATSCIRCUIT_MCP_TOKEN="$TOK"   # extrait du lockfile, session courante uniquement
```

## 4. Cursor — `.cursor/mcp.json` (`mcpServers`)

Source : `https://cursor.com/docs/context/mcp` (vérifié 2026-11-02).

- Projet : `.cursor/mcp.json` ; global : `~/.cursor/mcp.json`. Clé racine
  `mcpServers` (pluriel, avec `s`).
- Stdio : `{ "command": "npx|node|python|docker", "args": [...], "env": {...},
  "envFile": "..." }` (`envFile` réservé au stdio).
- Remote : `{ "url": "http://localhost:3000/mcp", "headers": {...} }`.
- Interpolation : `${env:NAME}`, `${userHome}`, `${workspaceFolder}`,
  `${workspaceFolderBasename}` — résolue dans `command`, `args`, `env`, `url`,
  `headers`. Donc **secrets via `${env:...}`, jamais en dur**.
- Debug : panneau Output → « MCP Logs ».

Copié-collable (`.cursor/mcp.json`) :

```json
{
  "mcpServers": {
    "niatscircuit": {
      "command": "node",
      "args": ["/ABS/NIATSCIRCUIT/bridge/bridge.mjs"]
    }
  }
}
```

Secours HTTP directe :

```json
{
  "mcpServers": {
    "niatscircuit-http": {
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": { "Authorization": "Bearer ${env:NIATSCIRCUIT_MCP_TOKEN}" }
    }
  }
}
```

## 5. Lockfile : chemins par OS + override

Source : `bridge/lib.mjs:12-29` (`defaultLockfilePath`, même sémantique que
`dirs::cache_dir` côté Tauri) + `bridge/README.md:22-32`.

| OS | Lockfile |
|---|---|
| Linux | `$XDG_CACHE_HOME/niatscircuit/mcp.json` sinon `~/.cache/niatscircuit/mcp.json` |
| macOS | `~/Library/Caches/niatscircuit/mcp.json` |
| Windows | `%LOCALAPPDATA%\niatscircuit\mcp.json` |

Override (tests, debug) : `NIATSCIRCUIT_MCP_LOCK=/chemin/mcp.json`.
Source : `bridge/lib.mjs:19`.

Contenu : `{ "port", "token", "pid", "startedAt", "url", "protocolVersion" }`
(exemple live : `url http://127.0.0.1:43267/mcp`, `protocolVersion 2026-07-28`).

## 6. Dépannage — 401 / token tourné / app fermée

Source : `bridge/bridge.mjs:62-83,119-133` (forward + rejeu), `bridge/lib.mjs:98-109`
(`appClosedError -32000`).

| Symptôme | Cause | Action |
|---|---|---|
| `401` ponctuel puis ça repart (stdio) | App relancée ⇒ token tourné | **Rien à faire** : le bridge relit le lockfile une fois et rejoue la requête (`forwardOnce` → relecture → retry). |
| `401` persistant (HTTP directe) | Token du lockfile régénéré | Re-extraire `TOK` du lockfile (§1–4) et reconfigurer le client HTTP. Ou repasser en stdio canonique (auto-récupération). |
| `-32000 « NIA studio fermé : ouvre l'app… »` | App Tauri fermée / lockfile absent / probe KO | **Ouvrir l'app**, puis reconnecter le client (`opencode mcp list`, `claude mcp get`, `/mcp` Reconnect, etc.). Jamais de headless au MVP — voulu. |
| `-32000` au démarrage du bridge | Lockfile illisible ou URL non-locale | Vérifier le chemin du §5 et que `url` matche `http://127.0.0.1:<port>/mcp` (`bridge/lib.mjs:132-134` rejette tout le reste). |
| Réponse vide `-32603` | Serveur injoignable entre-temps | Réseau coupé / app fermée entre deux requêtes : rouvrir l'app, le bridge re-probe et sort du mode dégradé (`bridge.mjs:102-117`). |
| Outil introuvable après ajout | Client non reconnecté | `opencode mcp list` / `claude mcp get niatscircuit` / Output → MCP Logs (Cursor) / redémarrage du client. |

Probe de santé manuelle (sans client MCP) :

```bash
LOCK=$HOME/.cache/niatscircuit/mcp.json
URL=$(python3 -c "import json;print(json.load(open('$LOCK'))['url'])")
TOK=$(python3 -c "import json;print(json.load(open('$LOCK'))['token'])")
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $TOK" \
  -d '{"jsonrpc":"2.0","id":"probe","method":"initialize","params":{"protocolVersion":"2026-07-28"}}'
# 200 attendu (app ouverte) ; 401 = token tourné, relire le lockfile
```

## 7. Écarts constatés dans le repo (pour le prototype, pas pour ce ticket)

- `bridge/README.md:44-47` : exemple opencode en forme V1
  (`{ "mcp": { "niatscircuit": { "type": "local", ... } } }`). À remplacer par
  la forme V2 `mcp.servers` + CLI `opencode mcp add` (§1). Le ticket #22 dit
  explicitement que le prototype README la consommera.
- `bridge/README.md:70-71` : exemple HTTP opencode en forme
  `{ "type": "remote", "url": ..., "headers": ..., "oauth": false }` **sans**
  l'enveloppe `mcp.servers.<nom>` — même correction V2 à appliquer.
- `opencode.json` racine : déjà correct en V2 — rien à y changer.
- Chemins relatifs (`bridge/bridge.mjs`, `node bridge/bridge.mjs`) dans les
  exemples README/CLI : à passer en absolu (ou `npx -y @nia-tscircuit/mcp-bridge`)
  pour Codex/Cursor/OpenCode multi-projets (§0).

## 8. Sources

- OpenCode V2 MCP : `https://opencode.ai/v2/docs/mcp-servers`
- OpenCode V2 config : `https://opencode.ai/v2/docs/config`
- Schéma config (vérité machine) : `https://opencode.ai/config.json`
- Skill opencode du repo (index V2) : § « MCP servers » (`mcp.servers`, `opencode mcp add --global`)
- Claude Code MCP : `https://code.claude.com/docs/en/mcp.md`
- Codex MCP : `https://developers.openai.com/codex/extend/mcp/`
- Cursor MCP : `https://cursor.com/docs/context/mcp`
- Repo : `bridge/bridge.mjs`, `bridge/lib.mjs`, `bridge/README.md`,
  `pcb-mcp/src/server.ts`, `opencode.json`, lockfile `~/.cache/niatscircuit/mcp.json`
