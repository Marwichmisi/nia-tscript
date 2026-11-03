# MCP comme couche d'outils pour l'agent intégré — étude wayfinder (issue #48)

- Statut : recherche AFK, sources primaires uniquement. Chaque affirmation est ancrée à sa source (chemin repo ou URL).
- Question : brancher l'agent IA **intégré** au studio directement sur le MCP (mêmes outils que le pilotage externe) est-il la bonne architecture, ou faut-il appeler les fonctions en direct ?
- Verdict : **AMENDER (valider le fond, rejeter la forme)** — oui à **une seule implémentation métier partagée** entre MCP externe et agent intégré, **non au loopback HTTP MCP** comme chemin d'appel in-app. Le câblage recommandé est : agent intégré (WebView) → **routeur d'outils TS local + commandes Tauri** → **cœur pur extrait de `pcb-mcp`** ; le sidecar MCP reste la **fine adaptation HTTP** de ce même cœur pour les pilotes externes.
- Fichiers à refactorer dans `pcb-mcp` : §6.

## 0. Résumé décisionnel

| Option | Verdict | Pourquoi (une ligne + source) |
|---|---|---|
| A. Agent intégré = client MCP `StreamableHTTP` vers `http://127.0.0.1:<port>/mcp` (mêmes outils, bearer du lockfile) | **Rejeté comme chemin principal** | Taxe protocole par appel (POST + JSON-RPC + headers `Mcp-*` + Bearer + guards Host/Origin), gestion du token et négociation d'era pour zéro gain fonctionnel in-app. Sources : `pcb-mcp/src/http.ts`, `pcb-mcp/src/server.ts`, `src-tauri/src/boot.rs`, [spec Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http), [SDK v2 serving/http](https://ts.sdk.modelcontextprotocol.io/v2/serving/http) |
| B. Agent intégré appelle les fonctions en direct (import TS + `invoke` Tauri), en dupliquant la logique métier | **Rejeté (duplication)** | Recréerait `compile`/`batch`/sourcing/Confinement/Lots/file une 3ᵉ fois alors que le miroir TS↔Rust existe déjà et est coûteux à synchroniser. Sources : `pcb-mcp/src/compile.ts` vs `src/src/lib/compile.ts`, `pcb-mcp/src/project.ts` vs `src-tauri/src/project.rs`, `docs/adr/0003-ecrivains-registre.md` |
| C. **(Recommandé) Cœur d'outils partagé, deux hôtes fins** : MCP HTTP pour l'externe, routeur local + commandes Tauri pour l'interne, même code métier | **Validé avec amendement** | Une seule implémentation des règles (Confinement, Lots atomiques, file `enqueue`, gates placement/routage/DRC) sans payer le loopback. Sources : `pcb-mcp/src/mcp.ts`, `pcb-mcp/src/queue.ts`, `pcb-mcp/src/batch.ts`, `src-tauri/src/lib.rs`, [Tauri sidecar](https://v2.tauri.app/develop/sidecar/), [Tauri calling-frontend](https://v2.tauri.app/develop/calling-frontend/) |

> Formule courte : **« MCP pour donner l'accès aux tools » est une bonne idée comme *contrat et cœur partagé*, une mauvaise idée comme *transport loopback in-app*.**

## 1. Ce que fait réellement le MCP aujourd'hui (base factuelle)

1. **Fabrique unique, double era.** `buildFactory()` construit un `McpServer` avec `registerTool` + `registerResource`, et `buildHandler()` l'enveloppe en `createMcpHandler(factory, { legacy: "stateless" })` = moderne `2026-07-28` + fallback `initialize` legacy. Source : `pcb-mcp/src/mcp.ts:505-510,2027-2030` ; définitions SDK `legacy?: 'stateless' | 'reject'` et `createMcpHandler` dans `pcb-mcp/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-DzlXH0KL.d.mts:277` et `index.d.mts` (export `createMcpHandler`, `legacyStatelessFallback`, `isLegacyRequest`).
2. **Surface d'outils (12 + 1 ressource).** `project_list/current/create/open/close`, `pcb_state`, `logs_read`, `code_patch`, `run_checks`, `live_manage`, `preview_screenshot`, `batch_execute`, `search_parts`, `fab_export` + ressource `pcb://hierarchy`. Chaque outil déclare `inputSchema`/`outputSchema` Zod, `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) et répond `{ content: [{ type: "text", text: JSON }], structuredContent: output }`. Source : `pcb-mcp/src/mcp.ts:512-646` (projets/lecture), `724-846` (`code_patch`), `1409-1645` (`batch_execute`), `1647-2021` (`search_parts`, `fab_export`).
3. **Confinement partout.** Tout outil d'écriture/lecture commence par `requireConfinedProject(tool)` → `currentProjectPath()` + `assertProjectMember()` (chemin canonique membre du Registre, sinon `OUT_OF_SCOPE`), les outils sans projet rendent `NO_PROJECT_OPEN`. Source : `pcb-mcp/src/mcp.ts:128-153`, `736-757`, `1426-1450` ; miroir Rust `assert_project_member` / `is_project_member` dans `src-tauri/src/project.rs:277-301` ; ADR `docs/adr/0001-mcp-scope-projet-ouvert.md`.
4. **File sérialisée mono-board.** Toutes les écritures passent par `enqueue(fn)` (chaîne de promesses, `tail.then(fn, fn)`), lectures hors file. Source : `pcb-mcp/src/queue.ts:1-20` ; usages `enqueue` dans `pcb-mcp/src/mcp.ts:563,596,630,734,1144,1424`.
5. **Lots atomiques.** `applyBatch()` est pur (sans I/O ni compile) : applique `patch|move|rotate|swap_package|reassign_net|route` en mémoire, premier échec → `{ ok:false, failedIndex, message }` ; l'appelant (`mcp.ts`) fait `snapshotStore()` avant, une seule `compileTsx` après, `restoreStore(snap)` + `rolledBack:true` si compile/gate route/DRC/persistance KO. Source : `pcb-mcp/src/batch.ts:44-113`, `pcb-mcp/src/mcp.ts:1482-1644` ; ADR `docs/adr/0002-lot-avec-routeur-local.md` (op `route` = `auto_local` + gate placement + preuve `pcb_trace` routée).
6. **Compile offline-first des deux côtés, mais deux implémentations.** Sidecar : `compileTsx()` via `CircuitRunner` de `@tscircuit/eval` en Bun, sans `entrypoint` (note prototype 83ab848), diagnostics embarqués extraits, `disableCdnLoading` strict. Frontend : `compileBoard()` via `createCircuitWebWorker` + `evalWebWorkerBlobUrl` bundlé, repli `runTscircuitCode` inline réseau, même stratégie CDN/offline et même extracteur (divergence mineure de regex). Source : `pcb-mcp/src/compile.ts:1-164`, `src/src/lib/compile.ts:1-156`, `docs/research/pipeline-tscircuit-tauri.md:§3-§5`.
7. **Sourcing, checks, fab : libs pures offline-first.** `search_parts` interroge `https://jlcsearch.tscircuit.com` (même source que `tsci search --jlcpcb`) + fallback DSL `footprinter` local compilé (`soup()`), refuse `disableCdnLoading`, refuse les sources non-`jlcpcb/lcsc`. `run_checks` = `@tscircuit/checks` natifs + gate placement dur (coords `pcbX/pcbY` explicites). `fab_export` = `circuit-json-to-gerber/bom-csv/pnp-csv/kicad` + `jszip`, avec 4 gates (compile verte, pas `routingDisabled`, DRC vert, preuve `isBoardRouted`) et écriture `<projet>/exports/<basename>-<hash12>`. Source : `pcb-mcp/src/sourcing.ts:1-11,241-403`, `pcb-mcp/src/checks.ts:1-13`, `pcb-mcp/src/fab.ts:1-11`, `pcb-mcp/src/board.ts:22-113`, `pcb-mcp/src/mcp.ts:1849-2019`.
8. **Transport HTTP local verrouillé.** `http.ts` n'accepte que `POST /mcp` sur `127.0.0.1`, guards `localhostHostValidation`/`localhostOriginValidation` de `@modelcontextprotocol/node`, `Authorization: Bearer <token>` (401 sinon), puis `toNodeHandler(handler)`. Le token est éphémère par boot (`generate_token`, 32 octets → base64), jamais loggé, distribué via lockfile `mcp.json` (`port/token/pid/startedAt/url/protocolVersion` + `projectPath`) en `0600`, calculé au même endroit des deux côtés (`base_cache_dir/niatscircuit`). Source : `pcb-mcp/src/http.ts:1-83`, `pcb-mcp/src/server.ts:31-59`, `src-tauri/src/boot.rs:19-114`, `bridge/lib.mjs:116-143` (`readLockfileSync`, regex `http://127.0.0.1:\d+/mcp`), `docs/research/transport-auth-mcp.md:§0-§1`, `docs/research/packaging-tauri-multiclient.md:§4-§5`.
9. **Pont stdio fin, pas de headless.** `bridge.mjs` (~240 lignes) relaie stdin MCP pur → `POST lock.url` + Bearer, extrait JSON ou SSE `data:`, stdout pur, logs stderr `[bridge]` seuls, `-32000 « ouvre l'app »` si probe KO, re-probe unique sur 401/réseau coupé, jamais de spawn serveur. Source : `bridge/bridge.mjs:1-240`, `bridge/lib.mjs:1-143`, `docs/specs/bridge-embedded.md`, `docs/research/transport-auth-mcp.md:§2-§3,§11`.
10. **Commandes Tauri existantes (le doublon partiel).** `list/create/open/close/forget/relink/delete_project`, `request_delete_token`, `read/write_project_main`, `save_screenshot`, `get_preview_dir`, `get_boot_state`, avec `generate_handler!`, Confinement jail côté Rust (`assert_project_member`), écriture atomique `boot::atomic_write`, `circuit.json` versionné `{ version:1, circuitJson }` des deux côtés. Source : `src-tauri/src/lib.rs:137-170,243-475,551`, `src-tauri/src/project.rs:142-251,342-404,466-513`, `src/src/lib/projects.ts:1-70`, `src/src/lib/compile.ts`, `src-tauri/src/boot.rs:116-160`.

## 2. In-process vs sidecar HTTP local vs commandes Tauri

### 2.1 Partage de code vs duplication

- **État actuel : deux miroirs assumés, pas un partage.** `project.ts` ↔ `project.rs` appliquent la même règle (absolu, pas de `..` même résolu, sans slash final, symlinks résolus, `canonical*`, écriture atomique tmp+rename+fsync, enveloppe `circuit.json` v1, Registre trié `lastOpened`) mais en deux langages, car le sidecar Bun (`node:fs/path/crypto/os`) et le backend Rust ne partagent ni runtime ni `AppHandle`. L'ADR l'acte comme « déviation » à deux écrivains atomiques plutôt qu'un canal sidecar→backend inexistant. Source : `pcb-mcp/src/project.ts:135-191`, `src-tauri/src/project.rs:65-80,116-134`, `docs/adr/0003-ecrivains-registre.md`.
- **Le pur est déjà partageable, le couplé ne l'est pas.** `batch.ts`, `patch.ts`, `live.ts` (mutations TSX par regex), `board.ts` (gates `routingDisabled`/`ExpectsRouting`, `withLocalAutorouter`, `isBoardRouted`, stats) sont **purs** (aucune I/O) et importables tels quels dans la WebView. À l'inverse `mcp.ts` couple dans chaque handler : garde Confinement + `enqueue` + `getCode/setCode` + `compileTsx` (Bun/`@tscircuit/eval` Node) + `persistProjectFiles` (`node:fs`) + `appendLog`, et `state.ts` mélange store mémoire et `currentProjectPath()` (lit le lockfile disque). Importer `mcp.ts`/`compile.ts`/`project.ts` dans le frontend Vite est donc impossible sans refactor (pas de `node:fs` en WebView, moteur compile différent). Source : `pcb-mcp/src/batch.ts:1-5`, `pcb-mcp/src/patch.ts:1-4`, `pcb-mcp/src/live.ts:1-4`, `pcb-mcp/src/board.ts:38-113`, `pcb-mcp/src/mcp.ts:733-844`, `pcb-mcp/src/state.ts:104-162`, `pcb-mcp/src/compile.ts:113-164`.
- **Conséquence.** Brancher l'agent sur le MCP **tel quel** (option A) évite d'écrire une 3ᵉ implémentation, mais fige le couplage Node du sidecar comme seul chemin. Appeler « en direct » sans extraction (option B) duplique `compile`+`batch`+sourcing+Confinement+Lots+file. La seule issue sans duplication ni loopback est l'option C : **extraire le cœur pur + schémas** et en faire la seule implémentation appelée par les deux hôtes. Sources : §1.5–§1.7 + `src/src/lib/compile.ts:43-72` (miroir extracteur à fusionner).

### 2.2 Latence, streaming, annulation

- **HTTP loopback = 1 TCP + 1 JSON-RPC + headers par outil.** Chaque `tools/call` in-app paierait : construction du body + `fetch POST` + guards Host/Origin + comparaison Bearer + `toNodeHandler` + double sérialisation (`content.text` JSON + `structuredContent`, dont `circuitJson` potentiellement volumineux) + parse SSE/JSON côté client (`extractResponseLines`). En boucle agent (patch→compile→checks→route→fab, itérations batch), c'est un surcoût systématique face à un appel fonction ou un `invoke` Tauri local. Sources : `pcb-mcp/src/http.ts:44-67`, `bridge/bridge.mjs:62-84,153-161`, `bridge/lib.mjs:80-96`, [spec Streamable HTTP — un POST par message, SSE scopé par requête](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http), [SDK v2 serving/http — factory fraîche par requête](https://ts.sdk.modelcontextprotocol.io/v2/serving/http).
- **Streaming/progress.** Côté MCP, les notifications serveur→client passent en MRTR/`subscriptions/listen` sur le stream SSE de la requête ; fermer le stream = annulation (pas de `notifications/cancelled` sur HTTP). Côté Tauri, le streaming adapté est `emit`/`emit_to` + `Channel` (mais payloads JSON, pas de gros messages, pas de support fin du système de capabilities sur les events). Pour un agent intégré, le besoin réel (progression compile, logs, screenshots) est mieux servi par events Tauri + `Channel` que par SSE MCP loopback. Sources : [spec Streamable HTTP — Cancellation, Message Flow](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http), [Tauri calling-frontend — events `emit`, channels](https://v2.tauri.app/develop/calling-frontend/), `src-tauri/src/lib.rs:142-193` (`save_screenshot`), `src/src/lib/screenshot.ts`.
- **File et concurrence.** La file `enqueue` sérialise déjà les écritures côté sidecar (lectures concurrentes OK). Un routeur local in-app doit **réutiliser la même file** (ou la même discipline : une seule mutation à la fois, snapshot avant, rollback après), sinon deux écrivains (agent interne + client MCP externe) divergent malgré l'atomicité fichier. Le loopback HTTP réutiliserait la file gratuitement ; l'option C doit donc **partager le module `queue.ts` tel quel** (il est déjà runtime-agnostique). Source : `pcb-mcp/src/queue.ts:5-20`, `docs/research/packaging-tauri-multiclient.md:§5.3,§6`.

### 2.3 Erreurs typées

- **MCP = erreurs protocole + diagnostics métier en payload.** Le SDK distingue `-32020` (HeaderMismatch), `-32021`, `-32022` (version non supportée), `-32601` (méthode inconnue), `-32000…-32019` legacy gelés ; les erreurs métier du studio (`NO_PROJECT_OPEN`, `OUT_OF_SCOPE`, ancre introuvable/ambiguë, gate placement/routage/DRC, disque KO avec `applied:false`) transitent en **payload 200** (`diagnostics[]`, `mode: refuse/echec`, `rolledBack`, `failedOpIndex`). C'est exploitable par un agent externe, mais moins typé qu'un `Result<T, E>` TS/Rust. Sources : `pcb-mcp/src/mcp.ts:121-126,739-780,1495-1544`, `bridge/bridge.mjs:134-160` (relais `-32020/-32022/-32601`, `-32000`, `-32603`), `pcb-mcp/node_modules/@modelcontextprotocol/server/dist/index.d.mts` (exports `HeaderMismatch`, `UnsupportedProtocolVersionError`, `SdkError`, `SdkHttpError`), [SDK v2 servers/errors](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors).
- **Tauri = `Result<T, String>` sérialisé, schémas Zod perdus.** Les commandes `#[tauri::command] … -> Result<…, String>` remontent des messages explicites (`chemin absolu requis`, `traversal .. refusé`, `hors périmètre (Confinement)`, `circuit.json corrompu…`, `jeton … invalide`) directement attrapables en `try/catch` frontend, sans mapping JSON-RPC. En revanche sans l'extraction des schémas Zod du MCP, l'agent perd le contrat d'outils (noms, descriptions, `outputSchema`). D'où le refactor : **générer le manifeste d'outils depuis les mêmes schémas Zod** pour les deux hôtes. Sources : `src-tauri/src/project.rs:45-63,283-301,152-172`, `src-tauri/src/lib.rs:295-475`, `src/src/lib/projects.ts:1-70`, [Tauri calling-rust](https://v2.tauri.app/develop/calling-rust/).

### 2.4 Versioning

- **MCP = négociation d'era à chaque connexion.** Serveur dual-era (`legacy: "stateless"`), versions `2026-07-28` + fallback `initialize`, matrice de compatibilité versioning, `SUPPORTED_PROTOCOL_VERSIONS`, `getProtocolEra()`, pin `{ pin: '2026-07-28' }` → `ERA_NEGOTIATION_FAILED` si mismatch. Faire passer l'agent intégré par ce chemin le couple au churn protocole (headers `Mcp-*`, `_meta.protocolVersion`, mismatch → `400`). Un appel direct est versionné avec l'app (plus `SERVER_VERSION = "0.1.0"` + `CIRCUIT_SCHEMA_VERSION = 1` déjà gérés). Sources : `pcb-mcp/src/mcp.ts:60-61,2027-2030`, `pcb-mcp/src/state.ts:17`, `pcb-mcp/src/project.ts:14-17`, `pcb-mcp/node_modules/@modelcontextprotocol/server/dist/index.d.mts` (`SUPPORTED_PROTOCOL_VERSIONS`, `LATEST_PROTOCOL_VERSION`, `DEFAULT_NEGOTIATED_PROTOCOL_VERSION`), `docs/research/transport-auth-mcp.md:§4,§12`, [SDK v2 protocol-versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).
- **Contrat d'outils à versionner une fois.** `inputSchema`/`outputSchema` Zod + `annotations` sont le vrai contrat agent. L'option C les garde **en un seul module** importé par `registerTool` (externe) et par le routeur agent (interne), avec un `tools-manifest` généré pour le prompt système. Sources : `pcb-mcp/src/mcp.ts:188-503` (schémas), `pcb-mcp/node_modules/@modelcontextprotocol/server/dist/mcp-BCJHyo7l.d.mts:3373-3538` (`registerTool`).

### 2.5 Sécurité — le Confinement est-il conservé ?

- **Oui dans les trois options, à condition de réutiliser les mêmes gardes.** Le Confinement = `canonicalProjectPath` + `is/assertProjectMember` (Registre après canonicalisation) côté TS, miroir `canonical_project_path` + `is/assert_project_member` côté Rust, + `NO_PROJECT_OPEN` sans projet, + jail `save_screenshot`/`get_preview_dir`. Le loopback HTTP le conserve gratuitement (gardes dans les handlers). L'option C le conserve **si** le routeur interne appelle les mêmes gardes (import TS pur + `assert_project_member` Rust via commande), et ne l'invente pas. Sources : `pcb-mcp/src/project.ts:258-289`, `src-tauri/src/project.rs:274-301`, `pcb-mcp/src/mcp.ts:128-153`, `src-tauri/src/lib.rs:148-193`.
- **HTTP ajoute une surface sans bénéfice in-app.** Bearer éphémère en lockfile `0600`, guards Host/Origin anti-DNS-rebinding, `401`/`403` : nécessaire face au réseau loopback exposé aux pilotes externes, superflu entre WebView et backend du même processus. Pire : l'agent intégré devrait **lire le token** (lockfile) et le joindre à chaque appel — le token devient accessible au contexte LLM (risque d'exfiltration par injection de prompt, logs, `ps`), alors que `invoke` Tauri n'a besoin d'aucun secret (capabilities + Confinement Rust). Sources : `pcb-mcp/src/http.ts:16-67`, `pcb-mcp/src/server.ts:46-57`, `src-tauri/src/boot.rs:49-56,104-114`, `docs/research/transport-auth-mcp.md:§1.2`, `docs/research/packaging-tauri-multiclient.md:§4`.
- **Règle.** Externe : MCP + Bearer + Host/Origin (inchangé). Interne : pas de Bearer, Confinement + capabilities Tauri + validation Zod des arguments avant exécution.

### 2.6 Maintenance — une seule implémentation ?

- **C'est l'argument le plus fort pour « MCP », mais il ne nécessite pas le transport MCP.** Ce qui coûte, ce sont les règles : patch ancré (0/1/>1 occurrences), epinglage `auto_local` + effort, gates placement/routage/DRC, preuve `isBoardRouted`, refus `routingDisabled`, scoring sourcing + `resolveFootprint`, exports + hash homonymes, Registre/lockfile atomiques, file `enqueue`. Toutes vivent déjà dans des modules **testables** (`batch`, `patch`, `live`, `board`, `checks`, `sourcing`, `fab`, `queue`, `project-core`). Le handler MCP n'est qu'un adaptateur (Zod → garde → file → cœur → `structuredContent`). Dupliquer cet adaptateur en commandes Tauri sans partager le cœur = double maintenance ; partager le cœur avec deux adaptateurs fins = maintenance unique. Sources : `pcb-mcp/src/mcp.ts` (adaptateurs), `pcb-mcp/src/batch.ts`, `pcb-mcp/src/patch.ts`, `pcb-mcp/src/live.ts`, `pcb-mcp/src/board.ts`, `pcb-mcp/src/sourcing.ts:133-232`, `docs/adr/0002-lot-avec-routeur-local.md`, `docs/adr/0003-ecrivains-registre.md`.
- **Coût caché du loopback.** Faire de `http://127.0.0.1/mcp` le chemin interne rend l'agent dépendant du boot sidecar (spawn, readiness, port/token, `probe`, stale-lock, single-flight, logs stderr+fichier). Si le sidecar est KO, l'agent intégré meurt avec les externes — alors qu'il pourrait fonctionner en mode dégradé (compile worker frontend + commandes Tauri). Sources : `pcb-mcp/src/http.ts:69-82` (readiness post-`listen`), `src-tauri/src/boot.rs:1-8` (seams boot/readiness/single-flight), `docs/research/packaging-tauri-multiclient.md:§5.2`, `src/src/lib/compile.ts:81-156` (repli inline).

## 3. Schéma de câblage recommandé (option C)

```text
┌─ Pilotes EXTERNES (claude/opencode/codex/cursor) ─────────────┐
│ stdio bridge (npx ou $RESOURCE/bridge.mjs)                     │
│   └─ POST 127.0.0.1:<port>/mcp + Bearer (lockfile 0600)       │
└───────────────────────────┬───────────────────────────────────┘
                            ▼
              ┌─ Sidecar pcb-mcp (Bun --compile) ─┐
              │ createMcpHandler(legacy:stateless) │
              │ registerTool × 12 (ADAPTATEUR FIN) │
              └───────────────┬───────────────────┘
                              ▼
              ┌─ tools-core/ (SEULE IMPLÉMENTATION) ────────────┐
              │ schemas Zod + patch/live/batch/board/checks/   │
              │ sourcing/fab-core + queue(enqueue) + guards    │
              │ Confinement + snapshot/rollback + diagnostics  │
              └───────────────┬───────────────────┘
                              ▲
┌─ Agent INTÉGRÉ (WebView, pas de HTTP, pas de Bearer) ────────┐
│ routeur d'outils local (mêmes schémas Zod, mêmes noms)        │
│  ├─ pur local : patch/live/batch/board/queue (import direct) │
│  ├─ Tauri invoke : project_* (Rust), read/write_main,        │
│  │   save_screenshot, fab_write (Rust, atomique+Confinement)  │
│  └─ compile : WebWorker blob-url (frontend) — même stratégie │
│      offline-first, même extracteur diagnostics               │
└───────────────────────────────────────────────────────────────┘
Disque = source unique de vérité (main.tsx + circuit.json v1) des deux côtés.
```

Règles du schéma :

1. **Un seul cœur, deux adaptateurs.** `tools-core/` ne fait ni HTTP ni `invoke` ni `fs` direct : il reçoit des dépendances injectées (`getCode/setCode`, `compileFn`, `persistFn`, `registryReader`, `logFn`). `mcp.ts` et les commandes Tauri/routeur ne font que valider (Zod), garder (Confinement), filer (`enqueue`), appeler le cœur, mettre en forme (`structuredContent` vs `Result`). Source : pattern existant `exportFab` pur + écriture par l'appelant dans `pcb-mcp/src/fab.ts:10-11`, `pcb-mcp/src/mcp.ts:1963-2019` ; à généraliser.
2. **Pas de token in-app.** Le routeur agent n'ouvre jamais le lockfile, n'envoie jamais de Bearer, ne parle jamais HTTP. La sécurité interne = Zod + `enqueue` + Confinement TS/Rust + capabilities Tauri.
3. **Compile injectée.** Le cœur appelle `compileFn(code, { disableCdnLoading })` : côté sidecar = `compileTsx` (Bun/`CircuitRunner`), côté app = `compileBoard` (WebWorker blob-url, repli inline). Les deux partagent le même extracteur de diagnostics et la même `CompileResult`. Source : `pcb-mcp/src/compile.ts:71-164`, `src/src/lib/compile.ts:43-156`.
4. **Persistance injectée.** Côté sidecar = `persistProjectFiles` (`node:fs` atomique) ; côté app = commandes Tauri `write_project_main` + `ensure_circuit_file` (Rust atomique `boot::atomic_write`). Les deux écrivent `main.tsx` + `circuit.json` v1, jamais de `applied:true` sur disque KO. Source : `pcb-mcp/src/project.ts:477-483`, `src-tauri/src/project.rs:208-251`, `pcb-mcp/src/mcp.ts:787-826`.
5. **Registre à deux écrivains atomiques (inchangé en V1).** L'ADR 0003 reste valide : pas de canal sidecar→backend, dernier écrivain gagne, fichiers toujours complets. L'agent intégré écrit via le backend (commandes Tauri), les pilotes externes via le sidecar — comme aujourd'hui. Source : `docs/adr/0003-ecrivains-registre.md`.

## 4. Ce qu'il faut refactorer dans `pcb-mcp` pour être consommable in-app

Ordre imposé (chaque item est testable séparément, aucun changement de comportement externe) :

1. **Extraire `tools-core/` pur (priorité 1).** Déplacer sans changer la logique : `patch.ts`, `live.ts`, `batch.ts`, `board.ts` tels quels (déjà purs) + `extractEmbeddedDiagnostics` + types `CompileResult/Diagnostic` hors de `compile.ts` + `resolveFootprint/scorePart/parseQueryHints` hors de `sourcing.ts` + `exportFab/sanitizeSegment` hors de `fab.ts` + `enqueue` hors de `queue.ts`. Critère : `tools-core/` n'importe ni `node:fs`, ni `node:path`, ni `process.env`, ni `@tscircuit/eval` au top-level (import dynamique injecté).
2. **Extraire les schémas Zod + manifeste (priorité 1).** `mcp.ts:63-503` → `tools/schemas.ts` (tous les `*Input/*Output`, `BatchOpSchema`, `ROUTE_EFFORTS`), exportés pour `registerTool` **et** le routeur agent + génération `tools-manifest.json` (nom/description/annotations) consommé par le prompt système de l'agent. Garder `mcp.ts` comme adaptateur fin.
3. **Séparer `project.ts` en `project-core` / `project-io` (priorité 1).** `project-core` : `validate/canonical/templateCode/serialize/parseCircuitFile/reconcileRegistry/isProjectMember/hashMainCode` (aucune I/O) → importable WebView. `project-io` : `load/saveRegistry`, `lockfile`, `ensure/persistProjectFiles`, `readMainWithHash` (`node:fs`) → sidecar seul ; le frontend utilise les commandes Tauri miroirs.
4. **Séparer `state.ts` store / résolution projet (priorité 2).** Store mémoire (`getCode/setCode/snapshot/restore/logs`) sans import `project.ts` ; la résolution `currentProjectPath()` devient un paramètre injecté (`resolveProject: () => string | null`) — lockfile côté sidecar, `BootState.project_path` côté app.
5. **Rendre `compile`/`sourcing`/`checks` injectables (priorité 2).** `compileTsx` ne doit plus être importé en dur par les handlers : signature `runTool(deps: { compileFn, persistFn, … })`. `searchParts` accepte déjà `fetchFn` — généraliser le pattern à `compileFn` et au file-système fab. Vérifier `@tscircuit/checks` en bundle WebView (sinon le garder côté sidecar + exposer `run_checks` via `invoke`, pas d'import frontend).
6. **Unifier l'extracteur de diagnostics (priorité 2).** Le sidecar teste `/(^|_)error$/` (strict, évite `error_report`), le frontend teste `includes("error")` (large, faux positifs possibles qui bloquent batch/export). Aligner les deux sur la version stricte sidecar + tests partagés.
7. **Figer les hooks de test hors prod (priorité 3).** `PCB_MCP_PROJECT_DIR`, `PCB_MCP_PREVIEW_DIR`, `PCB_MCP_EXPORT_DIR`, `NIATSCIRCUIT_MCP_LOCK`, `NIATSCIRCUIT_PROJECTS_FILE` restent des hooks de test documentés comme tels, jamais posés par le backend prod, non contrôlables via MCP — le routeur agent ne doit ni les lire ni les exposer.
8. **Exposer les commandes Tauri manquantes pour l'agent (priorité 2, côté Rust, pas `pcb-mcp`).** `run_checks`, `batch_execute`, `search_parts`, `fab_export` version `invoke` (mêmes règles, erreurs `Result<…, String>`) réutilisant `project.rs` + compile frontend ; `preview_screenshot` reste lecture disque partagée (`previews/` projet, repli cache global).
9. **Non-objectifs confirmés.** Pas de `mcp-use` (vue par outil + `outputSchema` view-bound + clés `_meta.ui.*` possédées contredisent le standing thin/texte+image), pas de FastMCP Python (second runtime + sidecar par triple pour zéro gain), pas de headless spawné par le bridge, pas d'écriture auto des configs agents.

## 5. Critères d'acceptation de la décision

- [ ] L'agent intégré fonctionne **sidecar éteint** (compile worker + commandes Tauri + cœur pur), mode dégradé explicite si réseau coupé.
- [ ] Les 12 outils + `hierarchy` donnent **le même résultat** en MCP externe et en routeur interne sur la matrice `matrix-v1` (`bun scripts/matrix-v1.mjs`, `pcb-mcp/package.json:scripts`).
- [ ] `cargo test` + `bun test` verts, dont Confinement (`OUT_OF_SCOPE`), atomicité Lots (`rolledBack`), gates (placement/routage/DRC), `circuit.json` v1 (créé/migré/corrompu-visible).
- [ ] Aucun import `node:` dans `tools-core/` ni dans le bundle WebView ; aucun Bearer/token dans le chemin agent interne ; stdout bridge toujours MCP pur.
- [ ] Cette étude reste la référence jusqu'à implémentation ; **ne pas implémenter ici** (décision seule, lead tranche).

## Sources

**Repo — cœur MCP/sidecar :**

- `pcb-mcp/src/mcp.ts` (fabrique, 12 outils, Confinement, file, Lots, gates, persistance)
- `pcb-mcp/src/project.ts` (Registre/lockfile, canonicalisation, atomicité, `circuit.json` v1, resync hash)
- `pcb-mcp/src/queue.ts` (file `enqueue` mono-board)
- `pcb-mcp/src/batch.ts` (moteur batch pur atomique + op `route`)
- `pcb-mcp/src/compile.ts` (worker `CircuitRunner`, offline-first, diagnostics embarqués)
- `pcb-mcp/src/board.ts` (fixture, `routingDisabled`/`ExpectsRouting`, `withLocalAutorouter`, `isBoardRouted`, stats)
- `pcb-mcp/src/live.ts` (mutations write-through pures), `pcb-mcp/src/patch.ts` (patch ancré 0/1/>1)
- `pcb-mcp/src/state.ts` (store mémoire + snapshot/rollback + logs), `pcb-mcp/src/checks.ts` (natifs + gate placement), `pcb-mcp/src/sourcing.ts` (JLCPCB-first + footprinter), `pcb-mcp/src/fab.ts` (gerbers/BOM/PnP/KiCad/zips)
- `pcb-mcp/src/http.ts` (POST `/mcp` 127.0.0.1 + Host/Origin + Bearer), `pcb-mcp/src/server.ts` (CLI `serve`, token via `PCB_MCP_TOKEN`)
- `pcb-mcp/package.json` (SDK `@modelcontextprotocol/server|node|client` v2, `@tscircuit/*`, `circuit-json-to-*`)

**Repo — pont, backend, frontend, docs :**

- `bridge/bridge.mjs`, `bridge/lib.mjs` (thin stdio→HTTP, lockfile, `-32000`, SSE `data:`)
- `src-tauri/src/project.rs` (miroir Rust : validation, canonicalisation, layout, circuit v1, Registre, Confinement, jeton suppression)
- `src-tauri/src/boot.rs` (lockfile, token éphémère, atomicité, `base_cache_dir`)
- `src-tauri/src/lib.rs` (commandes Tauri, BootState, screenshots, projets)
- `src/src/lib/compile.ts` (compile WebWorker blob-url + repli inline), `src/src/lib/projects.ts` (`invoke` projets), `src/src/lib/screenshot.ts`
- `docs/research/transport-auth-mcp.md` (HTTP canonique + bridge + SDK v2 + matrices clients)
- `docs/research/pipeline-tscircuit-tauri.md` (lib vs sidecar, APIs `@tscircuit/core|eval`, autorouter local, format projet)
- `docs/research/packaging-tauri-multiclient.md` (`externalBin` triples, capabilities `allow-spawn`, boot/readiness/single-flight, multi-client, logs)
- `docs/adr/0001-mcp-scope-projet-ouvert.md`, `docs/adr/0002-lot-avec-routeur-local.md`, `docs/adr/0003-ecrivains-registre.md`
- `docs/specs/bridge-embedded.md` (pont embarqué `$RESOURCE`, pas d'auto-config agents)

**Externes (primaires) :**

- [Spec Streamable HTTP (draft, rév. 2026-07-28)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http)
- [SDK TypeScript v2 — serving/http](https://ts.sdk.modelcontextprotocol.io/v2/serving/http)
- [SDK TypeScript v2 — servers/tools](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools)
- [SDK TypeScript v2 — clients/connect](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
- [SDK TypeScript v2 — servers/errors](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors)
- [Tauri v2 — Embedding External Binaries (sidecar)](https://v2.tauri.app/develop/sidecar/)
- [Tauri v2 — Calling the Frontend from Rust](https://v2.tauri.app/develop/calling-frontend/)
