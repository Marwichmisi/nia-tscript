# NIATSCIRCUIT Studio — PROTOTYPE README (brouillon, ticket #23, ne pas merger)

> ⚠️ Brouillon wayfinder : structure à valider avec le mainteneur avant de devenir le vrai `README.md` racine.
> Hypothèses marquées [HYPO] — à confirmer.

## C'est quoi ?

Studio PCB agentique (Tauri + tscircuit), piloté par ton agent IA via MCP.
L'app tourne en local, expose un serveur MCP HTTP ; ton agent s'y connecte via un petit pont stdio (`bridge/`).

## 5 minutes : installer → brancher → vérifier

### 1. Télécharger et installer

[HYPO — comment distribues-tu ? Releases GitHub ?] Brouillon :

| OS | Fichier | Commande |
|---|---|---|
| Linux | `.deb` / `.AppImage` (voir Releases) | `sudo dpkg -i nia-tscircuit-studio_0.1.0_amd64.deb` ou `chmod +x *.AppImage && ./*.AppImage` |
| macOS | `.dmg` (voir Releases) | Ouvrir le `.dmg`, glisser vers Applications |
| Windows | `.msi` / `-setup.exe` (voir Releases) | Double-clic |

Alternative dev : `npm run tauri build` (dépendances Rust + Node requises).

### 2. Prérequis : Node ≥ 20

Le pont MCP est un script Node sans dépendance :

```bash
node --version   # doit afficher v20 ou plus
```

### 3. Lancer l'app une fois

Ouvre NIATSCIRCUIT Studio. Au boot elle écrit son **lockfile** (URL + token éphémère) :

| OS | Lockfile |
|---|---|
| Linux | `$XDG_CACHE_HOME/niatscircuit/mcp.json`, sinon `~/.cache/niatscircuit/mcp.json` |
| macOS | `~/Library/Caches/niatscircuit/mcp.json` |
| Windows | `%LOCALAPPDATA%\niatscircuit\mcp.json` |

Vérifie qu'il existe avant de brancher ton agent. L'app doit rester **ouverte** (pas de mode headless : app fermée = erreur `-32000 « ouvre l'app »`, c'est voulu).

### 4. Brancher ton agent (canonique : pont stdio, chemin ABSOLU)

Remplace `/ABS/NIATSCIRCUIT` par ton chemin réel (`pwd` dans le dossier cloné).
[HYPO — faut-il documenter le clone git du repo pour le pont, ou seulement npx ?]

**OpenCode V2 (recommandé perso) :**

```bash
opencode mcp add niatscircuit --global -- node /ABS/NIATSCIRCUIT/bridge/bridge.mjs
opencode mcp list   # ✓ niatscircuit connected (app ouverte requise)
```

**Claude Code :**

```bash
claude mcp add --transport stdio niatscircuit -- node /ABS/NIATSCIRCUIT/bridge/bridge.mjs
claude mcp get niatscircuit
```

**Codex** (`~/.codex/config.toml`) :

```toml
[mcp_servers.niatscircuit]
command = "node"
args = ["/ABS/NIATSCIRCUIT/bridge/bridge.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

**Cursor** (`.cursor/mcp.json`) :

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

Variante sans clone (si publié npm) : `npx -y @nia-tscircuit/mcp-bridge` à la place de `node .../bridge.mjs`.
[HYPO — le paquet est-il publié ? Sinon retirer cette variante.]

### 5. Vérifier que ça marche

1. Dans l'app : onglet compile auto → `worker : N éléments, 0 erreur`, viewers Schéma/PCB/3D non vides.
2. Depuis ton agent : liste un outil / appelle `compile` ou `get_boot_state` — réponse JSON, pas d'erreur `-32000`.
3. `opencode mcp list` / `claude mcp list` : statut connected.

## Dépannage

| Symptôme | Cause → fix |
|---|---|
| `-32000 « ouvre l'app »` | L'app est fermée → ouvre-la (jamais de headless, voulu). |
| `401` / token rejeté | Token tourné (régénéré à chaque lancement) → en stdio ça se récupère seul ; en HTTP directe, ré-extraire `token` du lockfile. |
| `Refused to evaluate ... 'unsafe-eval'` | Vieille version : mets à jour (fix : `script-src` inclut `'unsafe-eval'`, ticket #21). |
| `RÉSEAU REQUIS`, viewers vides | Compile locale tombée + CDN injoignable → voir version + logs compile dans l'app. |
| `File not found "main.tsx"` | Vieille version : mets à jour (ENTRYPOINT aligné, ticket #24). |
| Jamais de token dans git | Le token est éphémère, il vit uniquement dans le lockfile. |

Secours HTTP directe (token éphémère, session courante uniquement) :

```bash
LOCK=$HOME/.cache/niatscircuit/mcp.json
URL=$(python3 -c "import json;print(json.load(open('$LOCK'))['url'])")
TOK=$(python3 -c "import json;print(json.load(open('$LOCK'))['token'])")
```

## Questions ouvertes pour le mainteneur (répondre avant de figer)

1. Distribution : Releases GitHub avec binaires par OS, ou install depuis les sources (`tauri build`) ? Les deux ?
2. Pont : chemin local `node bridge/bridge.mjs` (oblige à cloner le repo) vs `npx @nia-tscircuit/mcp-bridge` (oblige à publier/maintenir npm) — lequel en premier dans la doc ?
3. Version mini à exiger (celle qui contient fix CSP #21 + ENTRYPOINT #24) : `0.1.x` ? Faut-il un `app.getVersion()` / badge ?
4. Français, anglais, ou les deux pour ce README ?
