# Transport & Auth MCP — findings (issue #3)

Statut : recherche wayfinder AFK. Chaque claim cite sa source (URL ou chemin).
Question tranchée : transport + auth + langage/serveur pour le studio PCB desktop Tauri pilotable par agent IA via MCP (clients : opencode, claude code, codex, cursor).

## 0. Verdict (recommandation)

**HTTP local canonique + thin bridge stdio, SDK TypeScript officiel brut (`@modelcontextprotocol/server` v2), pas mcp-use au MVP, pas Python.**

- **Canonique = Streamable HTTP stateless, spec 2026-07-28**, servi par l'app (Tauri lance un sidecar Node ou sert via `createMcpHandler`), bind `127.0.0.1`, validation `Origin` + `Host`, token bearer éphémère par session.
  Sources : `https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http` (bind localhost SHOULD, Origin MUST, auth SHOULD) ; `https://ts.sdk.modelcontextprotocol.io/v2/serving/http` (`createMcpHandler`, per-request factory, guards `localhostHostValidation`/`localhostOriginValidation`, `requireBearerAuth`) ; `https://ts.sdk.modelcontextprotocol.io/v2/serving/express` (`createMcpExpressApp` arme Host+Origin par défaut sur bind localhost).
- **Compat = thin bridge stdio (~100 lignes, stdin/stdout ↔ POST localhost + Authorization)**, packagé npm, config par défaut des 4 clients en stdio ; alternative HTTP directe documentée avec headers.
  Sources : `https://modelcontextprotocol.io/specification/draft/basic/transports/stdio` (framing, stdout pur, stderr logs) ; configs clients §7 (toutes supportent stdio + HTTP).
- **Langage = SDK TS brut, pas mcp-use au MVP** : mcp-use impose `import 'mcp-use'`, 1 vue par outil, `outputSchema` obligatoire pour tout outil lié à une vue, clés `_meta.ui.*` possédées par le framework — tout le pipeline React/Views contredit le standing « thin MCP, preview texte+image d'abord ».
  Sources : `https://docs.mcp-use.com/v2/typescript/getting-started/welcome` (`import { MCPServer } from "mcp-use"`, vue par outil) ; `https://docs.mcp-use.com/v2/typescript/server/tools` (view-bound ⇒ `outputSchema` requis, une vue par outil, `_meta.ui.*` possédées).
- **Pas de Python (FastMCP)** : `Requires Python >=3.10` (`https://pypi.org/project/fastmcp/`, release 4.1.4, sdist 42,8 Mo) + sidecar à suffixer par triple (`https://v2.tauri.app/develop/sidecar/`) = second runtime à bundler pour zéro gain fonctionnel au MVP thin/offline-first.
- **Négociation = serveur dual-era** : parle 2026-07-28 stateless + fallback legacy `initialize` (défaut `legacy: 'stateless'` / `'serve'` du SDK), plan de test §8.
  Sources : `https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients` ; `https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions` ; `https://modelcontextprotocol.io/specification/draft/basic/versioning`.

## 1. Spec 2026-07-28 — Streamable HTTP (canonique)

Source principale : `https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http` (révision 2026-07-28 : suppression du endpoint GET, suppression des sessions protocolaires ; voir changelog + § Backward Compatibility de la page).

- Endpoint unique MCP en POST ; réponse `Content-Type: application/json` (objet unique) ou `text/event-stream` (SSE scopé à la requête) ; le client DOIT supporter les deux.
- Chaque message client = un POST ; le client NE DOIT PAS envoyer de JSON-RPC *responses* ; une notification acceptée ⇒ `202 Accepted` sans body.
- **Sécurité/endpoint** : le serveur DOIT valider `Origin` (invalide ⇒ `403 Forbidden`), DEVRAIT binder localhost (`127.0.0.1`) plutôt que `0.0.0.0`, DEVRAIT authentifier toutes les connexions.
- **Annulation** : fermer le stream SSE de réponse = annulation ; pas de `notifications/cancelled` sur HTTP (réservé à stdio).
- Pas de requêtes JSON-RPC initiées par le serveur sur le stream ; interactions serveur→client via MRTR (`InputRequiredResult`) ; notifications de changement via `subscriptions/listen`.
- `GET`/`DELETE` sur l'endpoint ⇒ `405 Method Not Allowed` (serveur moderne-only) ; header `Mcp-Session-Id` ignoré ; `Last-Event-ID` ignoré (streams non resumables).

### 1.1 Headers obligatoires (miroirs HTTP des champs body)

Source : même page, § Request Metadata + Server Validation. Le body reste la source de vérité ; mismatch ⇒ rejet.

| Header | Source body | Requis pour |
|---|---|---|
| `MCP-Protocol-Version` | `_meta.io.modelcontextprotocol/protocolVersion` | **toutes** les requêtes ; DOIT matcher le body sinon `400` + erreur `HeaderMismatch` (`-32020`) |
| `Mcp-Method` | `method` | **toutes** les requêtes |
| `Mcp-Name` | `params.name` (`tools/call`) ou `params.uri` (`resources/read`) | requêtes `tools/call`, `resources/read`, `prompts/get` |
| `Mcp-Param-{name}` | paramètres d'outil annotés `x-mcp-header` | seulement si l'`inputSchema` de l'outil le déclare (le client DOIT supporter) |

- Encodage : noms de headers insensibles à la casse, **valeurs sensibles à la casse** ; valeur non-ASCII / contrôles / espaces de bord ⇒ Base64 sentinelle `=?base64?...?=` (s'applique aussi à `Mcp-Name`) ; une valeur ASCII qui ressemble déjà à la sentinelle DOIT aussi être encodée.
- Version inconnue/non supportée ⇒ `400` + `UnsupportedProtocolVersionError` (`-32022`) listant `supported` ; méthode inconnue ⇒ `404` + `-32601` ; header manquant/mismatch ⇒ `400` + `-32020` ; requête sans `_meta` requis ⇒ `400` + `-32602` (Invalid params).
  Sources : page streamable-http § Server Validation ; codes d'erreur `https://modelcontextprotocol.io/specification/draft/basic/index` (§ Error Codes : `-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion ; `-32000..-32019` legacy gelés).
- Métadonnées par requête dans `_meta` : `io.modelcontextprotocol/protocolVersion` (requis), `clientCapabilities` (requis), `clientInfo` (recommandé), `logLevel` (optionnel). Le serveur NE DOIT PAS s'appuyer sur un état de connexion ; capacité manquante ⇒ `-32021`.
  Source : `https://modelcontextprotocol.io/specification/draft/basic/index` (§ `_meta`, § Statelessness).

### 1.2 Auth (transport HTTP)

Sources : `https://modelcontextprotocol.io/specification/draft/basic/authorization` ; `https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization`.

- HTTP ⇒ le framework OAuth s'applique (resource server : vérifie les bearer tokens, ne les émet jamais) ; **stdio ⇒ NE PAS suivre cette spec, credentials depuis l'environnement** (« STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment »).
- Token : `Authorization: Bearer <token>` sur chaque requête HTTP ; jamais dans l'URL ; `401` token invalide/expiré, `403` scopes insuffisants (avec challenge `WWW-Authenticate: Bearer …`), `400` requête malformée ; step-up via `scope` du challenge.
- SDK v2 : `requireBearerAuth({ verifier, requiredScopes, expectedResource, resourceMetadataUrl })` (Express : `requireBearerAuth` de `@modelcontextprotocol/express` ; web-standard : `requireBearerAuth` de `@modelcontextprotocol/server`) ; la factory reçoit `authInfo`, les handlers lisent `ctx.http.authInfo` ; scopes par opération via `scopeChallenge`/`requireScopes`.
- Choix MVP local : **bearer éphémère auto-généré** (pas d'OAuth complet) vérifié par un `verifyAccessToken` maison + `expectedResource` = URL locale ; OAuth complet reporté (serveur local mono-utilisateur, offline-first).

## 2. stdio (bridge)

Source : `https://modelcontextprotocol.io/specification/draft/basic/transports/stdio`.

- Le client lance le serveur en subprocess ; messages JSON-RPC **délimités par `\n`**, SANS newline embarquée ; UTF-8.
- Le client écrit requêtes/notifications sur `stdin`, NE DOIT PAS écrire de responses ; le serveur écrit responses + notifications sur `stdout`, NE DOIT PAS écrire de requests ; **stdout = MCP pur uniquement**.
- Le serveur PEUT logger sur `stderr` (info/debug/erreur) ; le client PEUT capturer/ignorer, NE DOIT PAS supposer que stderr = erreur.
- Métadonnées : tout inline dans le body (`_meta.*`), pas de couche headers.
- Annulation : `notifications/cancelled` avec l'ID (pas de stream par requête à fermer).
- Shutdown : le client ferme stdin → le serveur DEVRAIT sortir ; sinon `SIGTERM` puis `SIGKILL` (POSIX) / `TerminateProcess`/Job Objects (Windows) ; le serveur PEUT initier en fermant stdout.
- Crash : le client DEVRAIT relancer le process ; protocole stateless ⇒ requêtes en vol perdues, `subscriptions/listen` à rétablir.
- Même framing réutilisable sur socket Unix/TCP (custom transports SHOULD le réutiliser).

## 3. Pourquoi le double (HTTP canonique + bridge stdio)

- **stdio seul diverge en N états** : era pinnée par connexion (`serveStdio` décide l'era une fois par connexion ; défaut `'serve'`), probe via process sibling jetable sur le transport stdio du SDK (les serveurs qui exitent sur toute requête pré-`initialize` imposent de ne pas dépenser le process appelant), un subprocess par client (pas de partage), stderr/stdout à garder purs sous peine de casser le channel.
  Sources : `https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions` (§ Understand the probe : sibling process sur stdio, fallback legacy après timeout) ; `https://modelcontextprotocol.io/specification/draft/basic/transports/stdio` (§ Backward Compatibility : probe `server/discover`, fallback `initialize` sur toute autre erreur) ; `https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio` (`serveStdio(factory)`, stdout pur, EOF ⇒ teardown).
- **HTTP seul complique la discovery** : allocation de port + lockfile + probe avant spawn headless, configs clients hétérogènes (headers OAuth/bearer par client), clients qui exigent un lancement stdio par défaut.
  Sources : configs §7 (quatre formats différents) ; spec HTTP § Security (bind/Origin/auth à la charge du serveur).
- **Conclusion** : HTTP = état canonique unique (multi-clients, partageable, testable au `curl`) ; bridge stdio = adaptateur fin de compatibilité (pattern Figma/Playwright : serveur local + clients hétérogènes ; cf. §7 : Figma Local/Remote et Playwright listés comme serveurs MCP dans les docs Codex/Cursor).

## 4. SDK TypeScript officiel v2 (retenu) — surface utile

Sources : `https://github.com/modelcontextprotocol/typescript-sdk` (README : paquets `server`/`client`, runtimes Node/Bun/Deno, Standard Schema Zod v4/Valibot/ArkType) ; `https://ts.sdk.modelcontextprotocol.io/v2/` ; pages serving.

- Paquets : `@modelcontextprotocol/server` (dont `createMcpHandler`, `serveStdio`, `isLegacyRequest`, `legacyStatelessFallback`, `requireBearerAuth`, `toNodeHandler` via `@modelcontextprotocol/node`), `@modelcontextprotocol/client` (`Client`, `versionNegotiation: { mode: 'auto' | 'legacy' | { pin } }`, `getProtocolEra()`), middlewares `@modelcontextprotocol/express|fastify|hono|node` (thin : Host/Origin validation + JSON parsing, pas de logique métier).
- `createMcpHandler(factory)` : factory **fraîche par requête**, reçoit `{ era, authInfo, requestInfo }` ; retourne `{ fetch, close, notify, bus }` ; `responseMode: 'json'|'sse'` ; `legacy: 'stateless'` (défaut : sert aussi le 2025-era sans sessions ; `GET`/`DELETE` legacy ⇒ `405`) ou `'reject'` (moderne-only, `400` + `-32022`).
  Source : `https://ts.sdk.modelcontextprotocol.io/v2/serving/http`.
- Montage Node : `toNodeHandler(handler)` + `localhostHostValidation()` + `localhostOriginValidation()` + `listen(…, '127.0.0.1')` ; Express : `createMcpExpressApp()` (json + rebinding protection par défaut) + `app.all('/mcp', auth, (req,res) => node(req,res,req.body))`.
  Source : `https://ts.sdk.modelcontextprotocol.io/v2/serving/express`.
- Legacy routing : `isLegacyRequest(req)` devant un handler strict + `legacyStatelessFallback(factory)` pour garder un déploiement 2025 sessionful existant ; client v2 garde `SSEClientTransport` ; serveur v2 ne sert **jamais** HTTP+SSE (frozen `@modelcontextprotocol/server-legacy/sse` sur `GET /sse` + `POST /messages?sessionId=` si besoin transitoire).
  Source : `https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients`.
- Versions : `mode` absent/`'legacy'` = handshake `initialize` sans probe ; `'auto'` = probe `server/discover` + fallback ; `{ pin: '2026-07-28' }` = jamais de fallback (`SdkError` ERA_NEGOTIATION_FAILED) ; `supportedProtocolVersions` sans entrée pré-2026 ⇒ pas de fallback ; verdict cachable (`ConnectOptions.prior`).
  Source : `https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions`.
- Matrice d'eras (client×serveur modern/legacy/dual-era + sélection serveur par présence de `_meta` moderne vs `initialize`) :
  source `https://modelcontextprotocol.io/specification/draft/basic/versioning` (§ Backward Compatibility + Compatibility Matrix).

## 5. mcp-use — apport vs contraintes (écarté au MVP)

Sources : `https://github.com/mcp-use/mcp-use` (framework full-stack TS : serveurs, Views natives, inspector, CLI, déploiement Manufact) ; `https://docs.mcp-use.com/v2/typescript/getting-started/welcome` ; `https://docs.mcp-use.com/v2/typescript/server` ; `https://docs.mcp-use.com/v2/typescript/server/tools`.

- Apport : `MCPServer` stateless + outils/ressources/prompts typés (Standard Schema), **MCP App Views** (React, `useToolContext`), `mcp-use dev/build/start`, inspector `/mcp/inspector`, auth/middleware, `legacy: "stateless"|"reject"`.
- Contraintes (incompatibles thin-MVP) : `import { MCPServer } from "mcp-use"` (dépendance framework au lieu du SDK nu) ; **une vue par outil, `outputSchema` obligatoire pour tout outil view-bound** (« A view-bound tool must declare `outputSchema`, and one View can bind to only one tool ») ; **clés `_meta.ui.*` possédées** (le serveur set/supprime `ui.resourceUri`, `ui.visibility`, préserve le reste) ; pipeline React (`views/<name>/view.tsx`, `view.name` = nom du dossier, `mcp-env.d.ts`) + tunnel/déploiement Manufact hors sujet offline-first.
- Poids indicatif (stack dev **MCP-App-capable**, pas serveur thin) : benchmark vendeur `https://github.com/mcp-use/mcp-use` (README § How mcp-use compares) : 74,4 MiB / 51 paquets (mcp-use v2) vs 99,0 MiB / 119 paquets (officiel + ext-apps + Vite + zod) — ne pas citer comme coût du serveur thin ; sert seulement à montrer que l'écart se joue sur la stack Views.
- Décision : **réévaluer mcp-use uniquement si/when les vues interactives deviennent requises** (post-MVP, et seulement sur les clients qui rendent les Apps : Cursor oui, cf. §9).

## 6. FastMCP Python (écarté)

Sources : `https://gofastmcp.com` (framework Python serveurs+clients+apps : `from fastmcp import FastMCP`, `mcp.run()`) ; `https://pypi.org/project/fastmcp/` (4.1.4 : **Requires Python >=3.10**, sdist 42,8 Mo, extras `apps/openai/anthropic/…`) ; `https://v2.tauri.app/develop/sidecar/` (sidecar : binaire par triple `suffixe -$TARGET_TRIPLE`, `rustc --print host-tuple`).

- Écarté : second runtime (Python) à embarquer/sidecariser par triple + guideline offline-first/thin-MVP ; aucun besoin d'UI Apps au MVP (preview texte+image via `content` MCP standard, supportée partout : Cursor affiche les images retournées, cf. §7).

## 7. Tauri — packaging du serveur + bridge

Sources : `https://v2.tauri.app/develop/sidecar/` ; `https://v2.tauri.app/plugin/shell/` ; `https://v2.tauri.app/plugin/single-instance/`.

- `tauri.conf.json > bundle.externalBin` : chemins relatifs à `src-tauri` ; **un binaire par triple** (`my-sidecar-x86_64-unknown-linux-gnu`, `…-aarch64-apple-darwin`, …) ; exécution Rust via `app.shell().sidecar("my-sidecar")` (+ `.args([...])`, spawn/execute, stdin-write) ; JS via `Command.sidecar('binaries/my-sidecar', [...])`.
- Capabilities `src-tauri/capabilities/default.json` : `shell:allow-execute` (ou `allow-spawn` + `allow-stdin-write` pour le bridge long-lived) avec `sidecar: true`, `args` verrouillés par validateur (statiques en ordre exact, dynamiques par regex) ; scope par défaut restreint (open http(s)/tel/mailto).
- Single-flight : plugin `tauri-plugin-single-instance` (`init(|app, args, cwd| …)`, à enregistrer **en premier**) pour focus/fenêtre ; le lockfile MCP (§10) complète côté bridge/CLI (pid + probe), indépendant du plugin.

## 8. Matrice compat clients (config vérifiée)

| Client | stdio | HTTP directe | Notes |
|---|---|---|---|
| **claude code** | `claude mcp add --transport stdio <name> -- <cmd> [args…]` (`--env K=V`, `--` sépare les flags serveur) | `claude mcp add --transport http <name> <url> [--header "Authorization: Bearer …"]` ; en JSON `type: "http"` (alias `streamable-http`) ; `url` sans `type` = erreur ; SSE déprécié mais auto-fallback HTTP→SSE ≥ v2.1.265 | Runtimes v1/v2 (SDK 2.0 ⇒ 2026-07-28), `MCP_PROTOCOL_NEGOTIATION=auto\|legacy`, `MCP_SDK_GENERATION=v1\|v2` ; `CLAUDE_PROJECT_DIR`, `roots/list` ; timeouts `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT`/per-server `timeout` | Source : `https://code.claude.com/docs/en/mcp` |
| **opencode** | `{ "type": "local", "command": [...] }` | `{ "type": "remote", "url": "…", "headers": {…}, "oauth": {…}\|false }` ; OAuth auto (DCR RFC 7591), `opencode mcp auth/debug/list/logout` | `timeout` défaut 30 s ; glob `tools`/`agent.tools` | Source : `https://opencode.ai/docs/mcp-servers/` |
| **codex** | `[mcp_servers.x]` + `command/args/env/env_vars/cwd`, `startup_timeout_sec` (10), `tool_timeout_sec` (60) | `url` + `bearer_token_env_var` / `http_headers` / `env_http_headers` / `http_headers_helper` (JSON) ; `auth = "oauth"\|"chatgpt"` ; `codex mcp login` ; CIMD/DCR, `oauth-client-id/secret`, callback `http://127.0.0.1/callback` (RFC 8252/9207) ; `enabled/disabled_tools`, approvals | `config.toml` (`~/.codex/` ou `.codex/` projet), Figma Local/Remote + Playwright listés comme exemples | Source : `https://developers.openai.com/codex/mcp/` (liens `codex/config-file/*`) |
| **cursor** | `mcp.json` `{ "command", "args", "env", "envFile" }` | `{ "url", "headers", "auth": { CLIENT_ID/CLIENT_SECRET/scopes } }` ; OAuth PKCE + RFC 9728/8707, refresh, redirect `https://www.cursor.com/agents/mcp/oauth/callback` + `http://localhost:8787/callback` | 3 transports (`stdio`/`SSE`/`Streamable HTTP`) ; `type: "stdio"` ; `${env:…}`/`${workspaceFolder}` ; MCP Apps **Supported** ; images base64 supportées | Source : `https://cursor.com/docs/context/mcp` |

Snippets prêts (noms/ports à adapter ; voir §10 pour le lockfile) :

```bash
# claude code — défaut recommandé : bridge stdio
claude mcp add --transport stdio niatscircuit -- npx -y @nia-tscircuit/mcp-bridge
# variante HTTP directe (token éphémère du lockfile)
claude mcp add --transport http niatscircuit-local http://127.0.0.1:PORT/mcp \
  --header "Authorization: Bearer TOKEN"
```

```jsonc
// opencode — bridge stdio (opencode.json)
{ "mcp": { "niatscircuit": { "type": "local",
  "command": ["npx", "-y", "@nia-tscircuit/mcp-bridge"] } } }
// opencode — HTTP directe
{ "mcp": { "niatscircuit-local": { "type": "remote",
  "url": "http://127.0.0.1:PORT/mcp",
  "headers": { "Authorization": "Bearer TOKEN" }, "oauth": false } } }
```

```toml
# codex — ~/.codex/config.toml — bridge stdio
[mcp_servers.niatscircuit]
command = "npx"
args = ["-y", "@nia-tscircuit/mcp-bridge"]
startup_timeout_sec = 10
tool_timeout_sec = 60
# codex — HTTP directe
[mcp_servers.niatscircuit_local]
url = "http://127.0.0.1:PORT/mcp"
bearer_token_env_var = "NIATSCIRCUIT_MCP_TOKEN"
```

```jsonc
// cursor — .cursor/mcp.json ou ~/.cursor/mcp.json — bridge stdio
{ "mcpServers": { "niatscircuit": {
  "command": "npx", "args": ["-y", "@nia-tscircuit/mcp-bridge"] } } }
// cursor — HTTP directe
{ "mcpServers": { "niatscircuit-local": {
  "url": "http://127.0.0.1:PORT/mcp",
  "headers": { "Authorization": "Bearer TOKEN" } } } }
```

## 9. Matrice MCP Apps (qui rend les UI)

- Rendent les Apps : **Claude (web), Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, Archestra.AI, ChatGPT** (partiel skills), **Cursor (Supported, progressive enhancement : même outil marche sans rendu UI)**.
  Sources : `https://modelcontextprotocol.io/extensions/apps/overview` (§ Client support) ; `https://modelcontextprotocol.io/extensions/client-matrix` ; `https://cursor.com/docs/context/mcp` (ligne `Apps (extension) | Supported`).
- **claude code / opencode / codex : non listés comme rendant les Apps** (matrice communautaire : cases vides = non déclaré ; claude code n'apparaît que pour Apps/Tasks/Skills sans support déclaré).
  Source : `https://modelcontextprotocol.io/extensions/client-matrix`.
- Conséquence standing : **preview texte+image d'abord** (pas de dépendance aux MCP Apps/Views sur CLI) ; images base64 déjà supportées par Cursor (exemple `generate_image`, `https://cursor.com/docs/context/mcp` § Images as context) ; mcp-use réévalué seulement si besoin d'interactivité confirmé sur clients qui rendent.

## 10. Lockfile + single-flight + token (proposition)

- Emplacement : `~/.cache/<app>/mcp.json` (ex. `~/.cache/niatscircuit/mcp.json`), mode `0600` (token) ; contenu :
  `{"port": N, "token": "<aléatoire 256-bit base64>", "pid": N, "startedAt": "<RFC3339>", "url": "http://127.0.0.1:N/mcp", "protocolVersion": "2026-07-28"}`.
- Cycle de vie : généré au lancement de l'app (ou du premier bridge si headless) ; **token éphémère par session** (régénéré à chaque démarrage, jamais persisté ailleurs, jamais loggé) ; supprimé/rotation à la fermeture ; le bridge ne fait que le lire.
- Single-flight : le bridge, avant tout spawn headless, **probe** `POST <url>` (`server/discover` ou `tools/list` minimal avec headers) ; si vivant (2xx + JSON-RPC valide) ⇒ s'y attache (pas de spawn) ; sinon verrouille (lockfile `.lock`/`O_EXCL`), respawn le serveur headless, écrit le lockfile, vérifie `pid` vivant (`kill -0` / API OS) et stale-lock (pid mort ⇒ régénère).
  Fondement : stateless ⇒ requêtes perdues au restart acceptables, `listen` à rétablir (spec stdio § Unexpected Termination) ; probe/timeout pattern du SDK (`https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions` § Understand the probe).

## 11. Squelette du bridge (~100 lignes, Node, zéro-dep)

Contrat : stdin = MCP pur (lignes JSON-RPC) ; chaque ligne ⇒ `POST http://127.0.0.1:PORT/mcp` avec `Content-Type/Accept/MCP-Protocol-Version/Mcp-Method/Mcp-Name/Authorization: Bearer TOKEN` ; réponse (JSON ou SSE `data:`) ⇒ une ligne sur stdout ; logs ⇒ stderr uniquement ; EOF stdin ⇒ exit propre.

```js
#!/usr/bin/env node
// @nia-tscircuit/mcp-bridge — thin stdio↔HTTP (esquisse, ~100 lignes)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const LOCK = path.join(os.homedir(), ".cache", "niatscircuit", "mcp.json");
const VER = "2026-07-28";
const lock = JSON.parse(fs.readFileSync(LOCK, "utf8")); // {url, token}
// (single-flight + spawn headless si probe KO : ~30 lignes — voir §10)
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  const lines = buf.split("\n"); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-protocol-version": VER,
        "mcp-method": msg.method ?? "",
        "authorization": `Bearer ${lock.token}`,
      };
      const name = msg.params?.name ?? msg.params?.uri;
      if (name) headers["mcp-name"] = String(name);
      const r = await fetch(lock.url, { method: "POST", headers, body: line });
      const ctype = r.headers.get("content-type") ?? "";
      if (ctype.includes("text/event-stream")) {
        const text = await r.text(); // SSE : extraire les lignes `data: {...}`
        for (const ev of text.split("\n"))
          if (ev.startsWith("data:")) process.stdout.write(ev.slice(5).trim() + "\n");
      } else {
        const body = await r.text();
        if (r.ok && body) process.stdout.write(body.trim() + "\n");
        else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null,
          error: { code: -32000, message: `HTTP ${r.status}`, data: body.slice(0, 500) } }) + "\n");
      }
    } catch (e) { console.error("[bridge]", e?.message ?? e); }
  }
});
process.stdin.on("end", () => process.exit(0));
```

Packaging : paquet npm `bin: { "nia-tscircuit-mcp-bridge": "bridge.mjs" }`, `preferGlobal`, moteur Node ≥ 20 (fetch natif), zéro dépendance ; distribution : npm public + binaire sidecar Tauri qui embarque le même fichier (suffixe triple, `externalBin`, cf. §7).

## 12. Plan de test negotiation (stateless + legacy initialize)

Serveur : `createMcpHandler(factory)` défaut (`legacy: 'stateless'`) ; client de test : SDK v2 `Client` + `versionNegotiation: { mode: 'auto' }` (+ `getProtocolEra()`), sur les 4 clients réels + `curl`.

1. **Moderne stateless** : POST `tools/list` + headers §1.1 + bearer ⇒ 200, `_meta.io.modelcontextprotocol/serverInfo` présent, pas de `Mcp-Session-Id`.
2. **Legacy initialize** : client `mode: 'legacy'` (ou vieux client) ⇒ handshake `initialize` OK, réponse servie per-request ; `GET`/`DELETE` ⇒ `405`.
3. **Pin moderne** : `mode: { pin: '2026-07-28' }` contre serveur legacy-only ⇒ `SdkError` ERA_NEGOTIATION_FAILED (pas de fallback).
4. **HeaderMismatch** : `Mcp-Name` ≠ body ⇒ `400` + `-32020` ; version inconnue ⇒ `400` + `-32022` (`supported: ["2026-07-28", …]`) ; méthode inconnue ⇒ `404` + `-32601` ; POST sans `MCP-Protocol-Version` sur serveur moderne-only ⇒ `400`.
5. **Rebinding/auth** : `Origin: https://evil.test` ⇒ `403` ; `Host` non-localhost ⇒ `403` (via `createMcpExpressApp` défaut) ; sans bearer ⇒ `401` (+ `WWW-Authenticate`), mauvais scope ⇒ `403`.
6. **Bridge** : N bridges simultanés ⇒ un seul serveur (lockfile pid unique, probe avant spawn) ; kill serveur ⇒ bridge suivant respawn ; stdout du bridge = JSON-RPC pur (aucune ligne de log).
7. **Matrice clients** : les 4 configs §8 en stdio-bridge (défaut) + HTTP directe ; noter era négociée et rendu texte/image ; Apps : vérifier absence de rendu sur claude code/opencode/codex (attendu : texte seul), présence sur Cursor (progressive enhancement).

## 13. Incertitudes restantes (à vérifier par prototype, pas affirmées)

1. **Comportement réel des 4 clients face à 2026-07-28** : versions exactes supportées, envoi des headers `Mcp-*`, gestion du SSE par requête, fallback legacy automatique — les docs évoluent vite (claude code `MCP_SDK_GENERATION`/`MCP_PROTOCOL_NEGOTIATION`, codex `experimental_environment`, cursor `auth` statique). Le plan §12 doit être exécuté contre les binaires réels.
2. **Matrice Apps** : la client-matrix est communautaire (cases vides ≠ preuve d'absence) ; le rendu réel sur Cursor/ChatGPT/Desktop doit être testé avec un outil `_meta.ui` minimal.
3. **Lockfile** : `~/.cache` vs `XDG_RUNTIME_DIR` (Linux) / `~/Library/Caches` (macOS) / `%LOCALAPPDATA%` (Windows) — le chemin reste à figer par OS au prototype ; concurrence inter-processus à tester (stale-lock, `kill -0` sous Windows).
4. **Headless spawn depuis le bridge** : commande exacte (binaire Tauri `--mcp-server` ? sidecar node séparé ?), à trancher avec le packaging Tauri réel (issue d'implémentation, pas celle-ci).
5. **Tokens** : durée/rotation du bearer éphémère (par lancement d'app vs par heure), stockage zéro-disque du côté serveur (mémoire seule) — à fixer avec le threat model local (DNS rebinding déjà couvert par Host+Origin).
