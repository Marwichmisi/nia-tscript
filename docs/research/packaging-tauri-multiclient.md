# Packaging Tauri + multi-client — findings (issue #7)

Statut : recherche wayfinder AFK. Chaque claim cite sa source (URL ou commande locale).
Question tranchée : `externalBin` triple-suffixé, capabilities shell, boot `setup()` + lockfile single-flight, multi-clients simultanés, logs stderr-only, matrice de test par arch — pour le serveur MCP `pcb-mcp` (SDK TS v2 brut, HTTP local canonique + thin bridge stdio, bearer éphémère, file de commandes + readiness dès V1 — résolutions #3/#4).

Pas de scaffold créé (hors carte) : tout ce qui exige `tauri build` réel est rangé en §9.

## 0. Verdict

1. **Sidecar = un binaire `bun build --compile` par triple**, déclaré dans `bundle.externalBin`, nommé `binaries/pcb-mcp-<TARGET_TRIPLE>` (`.exe` sur Windows), spawné au boot dans `setup()` Rust en `spawn()` long-lived avec args `serve` verrouillés par validators. Sources : §1–§3.
2. **Capabilities = `shell:allow-spawn` + `shell:allow-stdin-write`** (pas `allow-execute`) avec `sidecar: true` + validators d'args ; le bridge npm côté client n'a besoin d'aucune capability (il tourne hors Tauri). Sources : §2.
3. **Single-flight = plugin `single-instance` en premier** (une seule instance d'app) **+ lockfile** `mcp.json` (port/token/pid, mode `0600`) écrit par `setup()` après probe de readiness ; le bridge ne fait que lire + prober, **ne spawne jamais** (option headless explicitement écartée au MVP, §4).
4. **Multi-clients = gratuit** : serveur stateless 2026-07-28, N bridges partagent l'URL du lockfile ; aucun état de connexion côté serveur. Source : §5.
5. **Logs : stdout = MCP pur** (bridge), stderr réservé aux logs des deux côtés ; le sidecar HTTP loggue sur stderr + fichier, jamais sur stdout. Source : §6.
6. **File de commandes + readiness V1** (note résolution #4) : le serveur porte une file drainée + gate de readiness ; le boot `setup()` attend `ready: true` avant d'écrire le lockfile. Source : §4.

## 1. Environnement local vérifié (2026-11-01, machine du driver)

Commandes exécutées telles quelles (aucune installation, aucun téléchargement lourd) :

```
$ rustc --version   → rustc 1.98.1 (48a229cea 2026-09-01)
$ cargo --version   → cargo 1.98.1 (797e8a9bc 2026-08-05)
$ rustc --print host-tuple → x86_64-unknown-linux-gnu
$ rustc -Vv | grep host → host: x86_64-unknown-linux-gnu
$ bun --version     → 1.3.11
$ node --version    → v26.13.0
$ npm --version     → 12.2.1
```

- `--print host-tuple` exige Rust ≥ 1.84.0 (source : `https://v2.tauri.app/develop/sidecar/`) — ici 1.98.1, OK.
- Triples desktop supportés par cette toolchain (extrait `rustc --print target-list`, vérifié) : `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`, `x86_64-apple-darwin`, `aarch64-apple-darwin`.

## 2. Sidecar `pcb-mcp-<triple>` — déclaration exacte

Sources : `https://v2.tauri.app/develop/sidecar/` ; `https://v2.tauri.app/learn/sidecar-nodejs/` ; `https://v2.tauri.app/reference/config/` (§ `BundleConfig.externalBin`).

- `tauri.conf.json > bundle.externalBin` : liste de chemins **relatifs à `src-tauri/`**. Le binaire réel embarqué porte le suffixe `-<TARGET_TRIPLE>` (`.exe` sur Windows). Tauri résout le bon binaire au runtime ; le code Rust/JS ne cite que le nom nu.
- Règle de nommage (doc) : `"externalBin": ["binaries/my-sidecar"]` exige `src-tauri/binaries/my-sidecar-x86_64-unknown-linux-gnu` sur Linux, `…-aarch64-apple-darwin` sur macOS Apple Silicon ; réf. config : `my-binary-x86_64-pc-windows-msvc.exe` (Windows), `my-binary-x86_64-apple-darwin` (macOS), `my-binary-x86_64-unknown-linux-gnu` (Linux).
- Exécution Rust : `app.shell().sidecar("my-sidecar")` (**nom seul, pas le chemin**) + `.args([...])`, `spawn()`/`write()` ; exige `tauri_plugin_shell::init()`. Exécution JS : `Command.sidecar('binaries/my-sidecar', [...])` (le string **doit matcher** l'entrée `externalBin`).

Snippets prêts (noms du projet) :

```jsonc
// src-tauri/tauri.conf.json
{ "bundle": { "externalBin": ["binaries/pcb-mcp"] } }
```

```
// Fichiers à produire au build (un par triple ciblé) :
src-tauri/binaries/pcb-mcp-x86_64-unknown-linux-gnu
src-tauri/binaries/pcb-mcp-aarch64-unknown-linux-gnu
src-tauri/binaries/pcb-mcp-x86_64-apple-darwin
src-tauri/binaries/pcb-mcp-aarch64-apple-darwin
src-tauri/binaries/pcb-mcp-x86_64-pc-windows-msvc.exe
src-tauri/binaries/pcb-mcp-aarch64-pc-windows-msvc.exe
```

```js
// Script de renommage post-build (pattern doc sidecar, adapté ; localement vérifié : rustc --print host-tuple → x86_64-unknown-linux-gnu)
import { execSync } from "node:child_process";
import fs from "node:fs";
const ext = process.platform === "win32" ? ".exe" : "";
const triple = execSync("rustc --print host-tuple").toString().trim();
if (!triple) throw new Error("target triple vide");
fs.renameSync(`pcb-mcp${ext}`, `src-tauri/binaries/pcb-mcp-${triple}${ext}`);
```

```rust
// src-tauri/src/main.rs — spawn long-lived (pattern doc sidecar)
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
let (mut rx, mut child) = app.shell().sidecar("pcb-mcp")?
    .args(["serve", "--port", &port.to_string()])
    .spawn()?;
```

```js
// Frontend (si besoin) : import { Command } from '@tauri-apps/plugin-shell';
const command = Command.sidecar('binaries/pcb-mcp', ['serve', '--port', String(port)]);
```

## 3. Build du sidecar : `bun build --compile` — fait vérifié

Sources : `bun build --help` local (bun 1.3.11) ; `https://bun.sh/docs/bundler` (§ Executables : `bun build ./cli.tsx --outfile mycli --compile`, « executable contains a copy of the Bun binary »).

Test local exécuté (répertoire jetable `/tmp/opencode/buncheck`, nettoyé après) :

```
$ printf 'console.log("hello-sidecar");\n' > hello.js   # 30 octets
$ bun build ./hello.js --outfile ./hello-bin --compile --target=bun-linux-x64
[97ms]  bundle  1 modules
[1110ms] compile  ./hello-bin
$ ls -la → hello-bin = 99 295 591 octets (~99 Mo), flag +x
$ ./hello-bin → hello-sidecar   # le binaire tourne
```

Faits établis :

- `--compile` implique `--production`, embarque **une copie du runtime Bun** : même un hello-world pèse **~99 Mo** (mesuré). Borne basse du sidecar `pcb-mcp` ≈ 100 Mo + code serveur (~lourd que le §7 de `pipeline-tscircuit-tauri.md` estimait à ~73 Mo npm + runtime : ordre de grandeur confirmé, pas de chiffre serveur réel sans build).
- `--target=bun-linux-x64` **fonctionne avec bun 1.3.11** (compilation + exécution vérifiées). Le cross-compile vers d'autres OS/archs passe par `--compile-executable-path` (« Path to a Bun executable to use for cross-compilation instead of downloading », `--help` local) — mécanisme prouvé par le flag, **binaires darwin/windows non produits ici** (téléchargement du runtime cible = hors périmètre, voir §9).
- Flags utiles constatés dans `--help` : `--bytecode` (démarrage plus rapide, ESM exige `--compile`), `--windows-hide-console` (sidecar Windows sans console), `--windows-icon/title/publisher/version/description/copyright` (métadonnées exe).
- Commande de build recommandée (à figer au scaffold) :
  `bun build ./src/mcp-server.ts --outfile pcb-mcp --compile --target=bun-<plateforme>-<arch> --bytecode`

## 4. Capabilities shell — JSON exact

Sources : `https://v2.tauri.app/develop/sidecar/` (§ Passing arguments, Running it from JavaScript) ; `https://v2.tauri.app/plugin/shell/` (table des permissions : `allow-execute`, `allow-spawn`, `allow-stdin-write`, `allow-kill` ; défaut `allow-open` http(s)/tel/mailto uniquement).

- `execute()` ⇒ `shell:allow-execute` ; **`spawn()` (notre cas, serveur long-lived) ⇒ `shell:allow-spawn`**. Le guide sidecar-nodejs utilise `"args": true` en exemple mais renvoie explicitement à la page sidecar pour verrouiller : **au MVP on verrouille**, `true` interdit.
- Args : statiques tels quels **dans l'ordre exact d'appel**, dynamiques par `{ "validator": "<regex>" }` (ex. doc : `{ "validator": "\\S+" }`). Tout appel dont les args ne matchent pas exactement est rejeté.
- Entrée `allow` : `{ "name": "binaries/pcb-mcp", "sidecar": true, "args": [...] }` (`sidecar: true` obligatoire ; `name` = entrée `externalBin`, pas le nom nu Rust).
- `allow-stdin-write` requis si Rust écrit sur stdin du sidecar (commandes drainées §4) ; `allow-kill` si arrêt explicite (recommandé pour le shutdown propre).

```jsonc
// src-tauri/capabilities/default.json — serveur HTTP long-lived (spawn)
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    { "identifier": "shell:allow-spawn", "allow": [
      { "name": "binaries/pcb-mcp", "sidecar": true,
        "args": ["serve", "--port", { "validator": "^[0-9]{2,5}$" }] }
    ] },
    { "identifier": "shell:allow-stdin-write", "allow": [
      { "name": "binaries/pcb-mcp", "sidecar": true }
    ] },
    { "identifier": "shell:allow-kill", "allow": [
      { "name": "binaries/pcb-mcp", "sidecar": true }
    ] }
  ]
}
```

```rust
// Appel Rust correspondant — DOIT matcher l'ordre exact des args ci-dessus
let (mut rx, mut child) = app.shell().sidecar("pcb-mcp")?
    .args(["serve", "--port", &port.to_string()])
    .spawn()?;
```

Notes verrouillées :

- Le **bridge npm tourne dans les process clients** (`npx -y @nia-tscircuit/mcp-bridge`), hors Tauri : **aucune capability** requise pour lui.
- Pas de `shell:allow-execute` sur `pcb-mcp` au MVP (un seul mode de lancement, `spawn`). Ne pas ajouter `"args": true` même en dev dans le fichier commité.
- `tauri_plugin_shell::init()` + `tauri_plugin_single_instance::init(...)` **en premier** dans le builder (source : `https://v2.tauri.app/plugin/single-instance/` : « must be the first one to be registered »), avant tout plugin pouvant interférer.

## 5. Boot Rust `setup()` + lockfile + single-flight + readiness

Sources : `https://v2.tauri.app/develop/sidecar/` (spawn/events/stdin-write) ; `https://v2.tauri.app/plugin/single-instance/` (callback focus `get_webview_window("main").set_focus()`, nom de service DBus `org.{identifier_avec_underscores}.SingleInstance`, manifests snap/flatpak) ; `https://modelcontextprotocol.io/specification/draft/basic/transports/stdio` (stateless ⇒ restart acceptable, § Unexpected Termination) ; `docs/research/transport-auth-mcp.md` §10–§11 (schéma lockfile, squelette bridge) ; note résolution #4 (file de commandes + readiness dès V1).

### 5.1 Emplacement du lockfile (par OS, vérifié)

Tauri résout les chemins via la crate `dirs` (source : `https://docs.rs/tauri/2.0.0/tauri/path/` — `PathResolver`, dépendance `dirs ^5`). Sémantique `cache_dir` (source : `https://docs.rs/dirs/latest/dirs/fn.cache_dir.html`) :

| OS | Répertoire cache | Lockfile MVP |
|---|---|---|
| Linux | `$XDG_CACHE_HOME` sinon `$HOME/.cache` (vérifié localement : `~/.cache/` existe et est peuplé) | `~/.cache/niatscircuit/mcp.json` |
| macOS | `$HOME/Library/Caches` | `~/Library/Caches/niatscircuit/mcp.json` |
| Windows | `{FOLDERID_LocalAppData}` (`C:\Users\<…>\AppData\Local`) | `%LOCALAPPDATA%\niatscircuit\mcp.json` |

En Rust : `app.path().app_cache_dir()` + `niatscircuit/mcp.json` (pas de chemin en dur ; le tableau ci-dessus est ce que ça produit). Schéma (inchangé depuis #3 §10, rappelé) : `{"port","token" (256-bit base64, éphémère, régénéré à chaque boot), "pid", "startedAt" (RFC3339), "url": "http://127.0.0.1:N/mcp", "protocolVersion": "2026-07-28"}`, fichier mode `0600` (Unix ; Windows : ACL utilisateur par défaut du profil — pas de chmod, voir §9).

### 5.2 Séquence `setup()` (ordre imposé)

1. `single-instance` déjà enregistré en premier (focus si 2ᵉ lancement, §4).
2. Tirer port libre (bind `127.0.0.1:0` puis release, ou laisser le sidecar choisir et le relire — à figer au scaffold ; le port final est celui écrit dans le lockfile) + générer token (`getrandom` 32 octets → base64).
3. `spawn()` du sidecar `["serve", "--port", port]` ; conserver le `child` dans l'état managé (`tauri::Manager`, `State`) pour `kill` au shutdown.
4. **Readiness** : poller `POST <url>` (`server/discover` + headers §1.1 de `transport-auth-mcp.md`, bearer) jusqu'à `ready: true` (la V1 inclut la gate de readiness : le serveur ne répond `ready` qu'après init file de commandes + rattachement projet — note #4). Timeout ~10 s ; échec ⇒ `kill` + erreur visible (pas de lockfile).
5. Écrire le lockfile (`0600`) **après** readiness. Stale-lock : si un `mcp.json` existe avec `pid` vivant (`kill -0` Unix / snapshot processes Windows — à tester §8), ne pas écraser aveuglément : le plugin single-instance garantit normalement l'unicité ; en cas de conflit, prober l'URL existante — vivante ⇒ s'y attacher (pas de 2ᵉ spawn), morte ⇒ régénérer.
6. Shutdown : `kill` du child + suppression/rotation du lockfile (token éphémère : jamais réutilisé d'un boot à l'autre, jamais loggé).

### 5.3 File de commandes drainée (V1, note #4)

Le sidecar HTTP porte la file de live-mutation restreinte (move/rotate/swap_package/reassign_net + sélection/vues, write-through TSX) : les requêtes `tools/call` mutantes arrivent dans la file, sont **drainées dans l'ordre** après la gate de readiness, chaque réponse inclut diagnostics + undo. Conséquences packaging vérifiées ici : (a) le boot doit attendre `ready` (§5.2.4) sinon les premiers appels clients échoueraient ; (b) stdin-write du sidecar (capability §4) est le canal Rust→serveur pour forcer le drain / injecter l'état projet ouvert ; (c) bridge inchangé (il relaie, il ne file pas).

### 5.4 Pont avec le bridge (rappel #3, frictions levées)

- Le bridge **ne spawne jamais** de serveur headless (décision MVP de ce ticket : l'option « spawn si probe KO » de `transport-auth-mcp.md` §10/§13.4 est **écartée** — elle exigerait un binaire servable hors Tauri + duplication du single-flight ; si probe KO le bridge répond une erreur JSON-RPC `-32000` « ouvre l'app » sur stderr + exit, cf. §6).
- Probe du bridge avant chaque… non : **une fois au démarrage du process bridge** (pas par requête — stateless, pas de session à maintenir ; re-probe seulement sur `fetch` refusé, puis une seule tentative, sinon erreur).
- Concurrence d'écriture du lockfile : un seul écrivain (le `setup()` de l'unique instance d'app) ; lecteurs N (bridges) en lecture seule ⇒ pas de `.lock/` nécessaire au MVP. Le `.lock`/`O_EXCL` de #3 §10 ne devient nécessaire que si le headless est un jour réintroduit.

## 6. Multi-clients simultanés

Fondement (sources : `https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http` — pas de sessions, chaque POST indépendant ; `https://ts.sdk.modelcontextprotocol.io/v2/serving/http` — factory fraîche par requête ; stdio § Unexpected Termination — requêtes en vol perdues au restart, client retry).

- N bridges (`claude`, `opencode`, `codex`, `cursor` en stdio, cf. configs `transport-auth-mcp.md` §8) → même `url` + même bearer du lockfile : aucun multiplexage à coder, le serveur traite chaque POST indépendamment (factory par requête).
- Test de simultanéité (exécutable sans scaffold, contre tout serveur de dev) : lancer 2+ bridges, appels `tools/list` concurrents + 1 `tools/call` mutante pendant un `tools/list` ⇒ un seul `pid` serveur, réponses corrélées par `id` JSON-RPC, file drainée dans l'ordre (§5.3).
- Limite honnête : la file de live-mutation sérialise les écritures (par design #4) ; les lectures restent concurrentes. À mesurer au scaffold : latence p95 sous 4 clients actifs (§8).

## 7. Logs : stderr-only du bridge (et du sidecar)

Source : `https://modelcontextprotocol.io/specification/draft/basic/transports/stdio` — « server MUST NOT write anything to stdout that is not a valid MCP message », « server MAY write UTF-8 strings to stderr », « client MAY capture/ignore stderr, SHOULD NOT assume stderr = error » ; shutdown : le client ferme stdin ⇒ le serveur SHOULD sortir ; sinon `SIGTERM`→`SIGKILL` (POSIX) / `TerminateProcess`/Job Objects (Windows).

Règles verrouillées :

- **Bridge** (client-spawned) : `stdout` = lignes JSON-RPC pures (réponse ou `data:` SSE extraite) ; **tout log → `console.error`** (stderr) ; `stdin 'end'` ⇒ exit propre. Le squelette `transport-auth-mcp.md` §11 est conforme (seul `console.error("[bridge]", …)` sur stderr) — repris tel quel, + préfixe `[bridge]` imposé pour filtrabilité.
- **Sidecar HTTP** : pas de contrainte stdout (pas de stdio), mais discipline identique — logs sur **stderr + fichier** (`app_log_dir`), jamais d'interférence avec le protocole ; readiness/errors HTTP restent dans les réponses.
- Vérification sans scaffold (à rejouer au §8) : `bridge < fixture.jsonl 2>/dev/null |` chaque ligne parse en JSON-RPC valide ; `2>&1 >/dev/null |` ne contient que `[bridge]…`.

## 8. Matrice de test par arch

### 8.1 Triples et différences (vérifié : `rustc --print target-list`, docs `externalBin`)

| Triple cible | Suffixe fichier | Spécifique (source) |
|---|---|---|
| `x86_64-unknown-linux-gnu` (hôte vérifié) | `pcb-mcp-x86_64-unknown-linux-gnu` | Référence CI ; lockfile `~/.cache/niatscircuit/` |
| `aarch64-unknown-linux-gnu` | `pcb-mcp-aarch64-unknown-linux-gnu` | Cross depuis x64 : `rustc --print host-tuple` du runner ≠ cible (script rename §2 à paramétrer, cf. doc : « will not work if you compile for a different architecture ») |
| `x86_64-pc-windows-msvc.exe` | `pcb-mcp-x86_64-pc-windows-msvc.exe` | `.exe` obligatoire ; `--windows-hide-console` au build Bun ; `TerminateProcess`/Job Objects pour le kill (spec stdio § Shutdown) ; lockfile `%LOCALAPPDATA%`, pas de `0600` (ACL) |
| `aarch64-pc-windows-msvc.exe` | `pcb-mcp-aarch64-pc-windows-msvc.exe` | Idem + runner ARM |
| `x86_64-apple-darwin` | `pcb-mcp-x86_64-apple-darwin` | Signature + hardened runtime (`macOS.hardenedRuntime`, réf. config) ; lockfile `~/Library/Caches` |
| `aarch64-apple-darwin` | `pcb-mcp-aarch64-apple-darwin` | Idem Apple Silicon ; notarisation requise en distrib (voir §9) |

Tauri `targets`/`bundle` : `macOS.minimumSystemVersion`, `windows.wix/nsis`, signing — réf. `https://v2.tauri.app/reference/config/` ; non vérifiables sans scaffold (§9).

### 8.2 Cas de test (par arch, ordre d'exécution)

1. **Nommage** : le binaire `<triple>` existe dans `src-tauri/binaries/`, `tauri build` l'embarque (log bundler), l'app lance le bon suffixe (le nom nu `pcb-mcp` résout le triple du runner).
2. **Capabilities** : `spawn` avec `["serve","--port","1234"]` OK ; `["serve","--port","evil;rm"]` rejeté ; arg manquant/ordre différent rejeté ; `stdin_write` OK ; `kill` OK.
3. **Boot** : cold start ⇒ lockfile écrit **après** readiness (`ready:true`), `0600` (Unix), `pid` = child réel ; 2ᵉ lancement ⇒ focus (single-instance), pas de 2ᵉ lockfile.
4. **Stale-lock** : kill -9 de l'app, relance ⇒ probe KO ⇒ régénération port+token (pas de réutilisation du token mort).
5. **Multi-client** : 2 bridges simultanés (fixtures `tools/list` + `tools/call` mutante) ⇒ 1 seul serveur, `id` corrélés, ordre de drain conforme §5.3.
6. **Logs** : test de pureté stdout/stderr §7 sur fixtures incluant requêtes invalides (erreurs → stderr uniquement).
7. **Port occupé** : port du lockfile squatté par un tiers ⇒ `setup()` choisit un autre port (pas de crash, erreur lisible si aucun port).
8. **Latence file** (indicatif) : p95 `tools/call` mutante sous 4 clients concurrents, consigné par arch.
9. **Linux snap/flatpak** : DBus `org.<identifier_underscoré>.SingleInstance` déclaré (slot+plug `single-instance`, finish-args `--talk-name/--own-name` — source : page single-instance § Usage in Snap and Flatpak). Sans ça, single-flight cassé en sandbox.

## 9. Reste à prouver avec le scaffold (limites honnêtes)

Non vérifiable sans `tauri init` + `tauri build` réel (interdit sur cette carte) :

1. **Build/bundling réel** : embarquement `externalBin` par triple, taille du bundle (borne basse mesurée : ~99 Mo sidecar seul, §3), `tauri build` vert par OS.
2. **Cross-compile Bun darwin/windows** : binaires non produits ici (téléchargement runtime cible) ; tailles et `--windows-*` à mesurer.
3. **Updater + signing** : `createUpdaterArtifacts`, signature macOS/notarisation, certificat Windows (`windows.certificateThumbprint`, `signCommand`), `hardenedRuntime` — réf. config, jamais exercés.
4. **Kill/shutdown Windows** : `allow-kill` + `TerminateProcess`/Job Objects en pratique ; suppression lockfile à la fermeture.
5. **Snap/Flatpak DBus** : manifests §8.2.9 non testés.
6. **ACL Windows du lockfile** : équivalent effectif du `0600` (profil utilisateur seul lecteur) à valider.
7. **Headless spawn** : écarté au MVP (§5.4) ; si réintroduit un jour : commande exacte, `.lock`/`O_EXCL`, stale-lock Windows — tout à prouver.
8. **Token** : rotation (par boot seul au MVP ; horaire si audit l'exige) + zéro-stockage côté serveur (mémoire seule) — à figer avec le threat model.
9. **Comportement réel des 4 clients face à 2026-07-28** (headers `Mcp-*`, SSE par requête, fallback legacy) : déjà listé en `transport-auth-mcp.md` §13.1–§13.2, inchangé — le plan de test §12 de ce doc reste la référence côté protocole.
10. **Latence p95 §8.2.8** et **ports éphémères vs fixes** : mesures scaffold uniquement.

## Sources (primaires, vérifiées le 2026-11-01)

- `https://v2.tauri.app/develop/sidecar/` (externalBin + suffixe triple + `rustc --print host-tuple` + rename script + Rust `shell().sidecar().args().spawn()` + JS `Command.sidecar` + args validators + `capabilities/default.json`)
- `https://v2.tauri.app/learn/sidecar-nodejs/` (cycle package→rename→capability→externalBin→execute ; `"args": true` exemple + renvoi vers validators)
- `https://v2.tauri.app/plugin/shell/` (table `allow-execute/allow-spawn/allow-stdin-write/allow-kill`, Rust ≥ 1.90 requis — ici 1.98.1 OK, `sh`-sidecar exemple)
- `https://v2.tauri.app/plugin/single-instance/` (premier plugin, closure `app/args/cwd`, focus, service DBus `org.{id}.SingleInstance`, manifests snap/flatpak, aucune capability requise)
- `https://v2.tauri.app/reference/config/` (`BundleConfig.externalBin`, patterns par OS, macOS `hardenedRuntime`, Windows signing, `BundleTarget`)
- `https://docs.rs/tauri/2.0.0/tauri/path/` (`PathResolver`, dépendance `dirs ^5`) ; `https://docs.rs/dirs/latest/dirs/fn.cache_dir.html` (table Linux/macOS/Windows)
- `https://modelcontextprotocol.io/specification/draft/basic/transports/stdio` (stdout pur, stderr logs, shutdown stdin/SIGTERM/TerminateProcess, restart stateless, probe `server/discover`)
- `https://bun.sh/docs/bundler` (§ Executables) + `bun build --help` local bun 1.3.11 (`--compile`, `--target`, `--compile-executable-path`, `--bytecode`, `--windows-*`)
- `https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bin` (`bin` : map nom→fichier, symlink/PATH, `#!/usr/bin/env node` requis)
- Local : `rustc 1.98.1 / cargo 1.98.1 / x86_64-unknown-linux-gnu / bun 1.3.11 / node v26.13.0 / npm 12.2.1` ; test `bun build --compile` hello.js → 99 Mo, exécutable (détail §3) ; `rustc --print target-list` (6 triples desktop) ; `~/.cache/` constaté.
- Repo : `docs/research/transport-auth-mcp.md` (§7–§8 configs clients, §10–§11 lockfile + squelette bridge, §12 plan negotiation, §13 incertitudes protocole) ; `docs/research/pipeline-tscircuit-tauri.md` (§7 sidecar, poids) ; note résolution #4 sur ticket #7 (file drainée + readiness V1).
