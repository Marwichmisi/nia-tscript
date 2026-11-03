# Diagnostic ticket #52 — `project_open` / `project_close` MCP sans effet sur l'app

Méthode : skill `diagnosing-bugs` suivie (boucle de repro **RED** exécutée, hypothèses classées, instrumentation en lecture seule).
Contraintes respectées : Projets **jetables `/tmp` uniquement** (créés puis **supprimés**), **RIEN corrigé, committé, poussé** avant ce versement, repo intact (`git status` : seul `bun.lock` untracked pré-existant). Secrets expurgés : token prod jamais affiché, boucle avec token factice.
Contexte live constaté : **app fermée** (aucun process `niatscircuit|tauri|pcb-mcp`), lockfile prod **obsolète** (pid mort) avec `projectPath` résiduel.

## 1. Chaîne causale précise (qui écrit / observe quoi, où ça casse)

**Écrivains (deux, ADR-0003 actée : « aucun canal sidecar→backend n'existe »).**
- MCP `project_open` (`pcb-mcp/src/mcp.ts:595-611`) : `canonicalProjectPath` + `ensureCircuitFile` + `upsertRegistry`/`saveRegistry` + `writeLockProjectPath(dir)` + `loadCodeForProject`. `project_close` (`mcp.ts:629-639`) : `writeLockProjectPath(null)`.
- Rust `open_project` / `create_project` / `close_project` (`src-tauri/src/lib.rs:295-348`) : `canonical_project_path` + `ensure_*` + `upsert/save` + **`set_current` + `rewatch`**.
- `writeLockProjectPath` (`pcb-mcp/src/project.ts:394-416`) : **en prod ne crée JAMAIS** (early-return l.409 si read/parse KO sans `NIATSCIRCUIT_MCP_LOCK`/`file`), **patche seulement** le lock existant (préserve `url`/`token`). Miroir Rust `write_lock_project` (`src-tauri/src/project.rs:493-513`, via `set_current` `lib.rs:220-223`). App ouverte → patch OK. **App fermée** (lock supprimé `lib.rs:519-524`) → MCP `open` met à jour le **Registre seul**, `currentProjectPath` (`project.ts:355-378`, repli env `PCB_MCP_PROJECT_DIR` = hook de test) reste `null` : même le MCP se voit en Accueil.

**Lecteurs divergents — c'est LA cassure, pas le lockfile.**
- MCP `project_current` (`mcp.ts:541`) lit le **lockfile**. App `current_project` (`lib.rs:279-293`) lit **`BootState.project_path` en mémoire**, jamais le lockfile.
- `set_current` n'est appelé que par les commandes Rust (`lib.rs:287,309,335,345,409,436`) + boot `from_lock` (`lib.rs:100-110,578-602`). Le sidecar, processus séparé, **ne peut pas** changer l'état de l'app.

**Preuve boucle RED** (harness `bun` jetable, env `NIATSCIRCUIT_MCP_LOCK`/`PROJECTS_FILE` isolés, copie conforme `mcp.ts:597-608` + `631`, `BootStateSim` = valeur boot figée comme le Rust) :
```
OPEN(B)  lockfile=B | Registry.lastOpened=B | frontend(BootState)=A → RED-OPEN
CLOSE()   lockfile=null | frontend(BootState)=A                  → RED-CLOSE
```

**Event manquant + refresh mort + watcher aveugle.**
- Seul event = `project-main-changed` (`src-tauri/src/watch.rs:20`), émis par `rewatch_main` (`lib.rs:52-75`) ré-armé **uniquement** sur commandes Rust + boot (`lib.rs:539`). MCP `open` ne rewatch pas → watcher reste sur l'ancien Projet.
- `watch_project_main` (`watch.rs:97-122`) : dossier en **non-récursif**, filtre `e.path == main`, gate anti-boucle sur hash. `App.tsx:551-558` filtre `isMainOfProject` sur le Projet BootState courant, puis `resyncFromDisk` relit `readProjectMain(cur BootState)`. Donc le watcher ne resync **que `main.tsx` du Projet que l'app croit ouvert** — jamais un changement de Projet.
- Polling 15 s (`App.tsx:566-584`) niché dans le **`.catch` du `listen`** → **code mort en prod** (sous Tauri `listen` réussit). `refreshProjects` (`App.tsx:278-301`) ne tourne qu'au mount + après actions UI, et lit `current_project` (BootState) → même un refresh manuel raterait le changement MCP.

## 2. LA décision de fix proposée (sans l'implémenter)

**Source de vérité unique = disque (`mcp.json:projectPath` + `projects.json`), `BootState` = simple miroir synchronisé.**
- **Backend** : surveiller `mcp.json` (et `lastOpened`) côté Rust — notify ou poll 1-2 s en thread dédié. Au changement canonique : vérifier existence dossier + appartenance Registre (`assert_project_member`, Confinement) + réconciliation orphelin, puis `set_current` + `rewatch` + `emit` d'un **nouvel event `project-open-changed` `{ projectPath: string|null }`** (distinct de `project-main-changed`). Conserver : patch partiel url/token, atomicité tmp+rename+fsync, garde prod « MCP ne crée jamais » (lock absent = Accueil). Trancher le cas app fermée : MCP `open` n'écrit que le Registre ; au boot, reprendre `Registry.lastOpened` quand le lock n'a pas de `projectPath`.
- **Frontend** : écouter `project-open-changed` → `refreshProjects` + relecture `main` + reset `knownHash`/`readError` ; sortir le polling du `.catch` pour en faire un **repli permanent** (ex. 5 s sur `current_project`) en plus du `listen`.
- **Rejeté** : faire appeler les commandes Tauri par le sidecar — aucun canal IPC (ADR-0003), hors spec V1, trop risqué.

## 3. Comment la vérifier

- **Harness** : harness `bun` jetable (rejeu `mcp.ts:597-608`/`631` en env isolé + `BootStateSim`) : avant fix RED-OPEN/RED-CLOSE ; après fix, avec le watcher backend actif, le miroir doit suivre → GREEN.
- **Live** (app ouverte, Projets jetables `/tmp/nia-verify-*` uniquement) : `project_open` via MCP → sans aucun clic, l'app bascule sur B (bannière/éditeur), event `project-open-changed` reçu, watcher ré-armé (éditer `main.tsx` de B → toast resync) ; `project_close` → retour Accueil. Répéter app fermée (garde prod : Registre seul, `project_current` null) + réouverture (reprise `lastOpened`). Contrôler : Confinement (hors-Registre refusé), atomicité (aucun `.tmp` résiduel), orphelins (dossier supprimé → Accueil, Registre conservé).
