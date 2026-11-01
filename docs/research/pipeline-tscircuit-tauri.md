# Pipeline de compilation tscircuit embarqué dans Tauri — recherche wayfinder (issue #2)

- Date : 2026-11-01 (versions vérifiées ce jour, `main`/`latest` npm).
- Scope : trancher lib (`@tscircuit/core + @tscircuit/eval`) vs sidecar `tsci` vs hybride, offline autorouter + `@tsci/*`, format projet imposable à l'agent.
- Méthode : sources primaires uniquement (repos `tscircuit/*`, `docs.tscircuit.com`, registry npm, `v2.tauri.app`). Aucune API inventée : tout point est ancré à un fichier/raw ou une page listée en § Sources.
- Préférences standing respectées : offline-first local, licences MIT-compatibles uniquement, MCP thin.

## Verdict : hybride à dominante lib (recommandé)

**Recommandation : pipeline principal = `@tscircuit/core` + `@tscircuit/eval` en lib, exécuté en WebWorker avec `blob-url` bundlé (offline-first). Sidecar `tsci` = optionnel, phase 2, réservé au batch/exports lourds (`build --site --bundle-jscdn`, `export gerbers/kicad/altium/step`, `snapshot --ci`, `check`).**

Justification courte :

1. **Perf/UX :** le WebWorker (`createCircuitWebWorker`, Comlink) non-bloque l'UI et isole les freezes d'autorouting ; le mode inline `CircuitRunner` reste dispo pour debug/tests. Le multithread local (`autorouterThreads: 4`, `solveAsync`, Bun ≥1.4.2) est déjà le défaut CLI sur desktop.
2. **Offline :** le défaut lib est local (autorouter `local: true`, presets `default`/`auto`/`auto-local`) ; le cloud est opt-in (`auto_cloud`, `useCloudAutorouter`). Le seul point réseau obligatoire est résoluble par bundling + caches (worker blob, `jscdn`, `cjs.tscircuit.com`, `kicad-mod-cache`).
3. **Poids :** lib = ~17 Mo (`core` dist) + ~67 Mo (`eval` dist, contient le runtime + workers) + ~73 Mo (`tscircuit` npm tout compris), contre un binaire `tsci` par triple à builder/livrer/signer soi-même (pas de binaire prébuilt versionné constaté dans les sources ; build `bun` local). Bundler le worker en `blob-url` évite tout fetch CDN au runtime.
4. **Maintenabilité :** `tsci` = grosse surface (dev-server, runframe standalone, workers de build, python/palace pour simulation) ; l'app Tauri n'en a besoin que comme outil batch. La lib suit le même `core` que le CLI, sans dupliquer la logique de build.

## 1. Versions vérifiées (2026-11-01)

| Paquet | Version `latest` / `main` constatée | Source |
|---|---|---|
| `@tscircuit/core` | `0.0.2245` | https://registry.npmjs.org/@tscircuit%2Fcore/latest + https://raw.githubusercontent.com/tscircuit/core/main/package.json |
| `@tscircuit/eval` | `0.0.1681` | https://registry.npmjs.org/@tscircuit%2Feval/latest + https://raw.githubusercontent.com/tscircuit/eval/main/package.json |
| `tscircuit` (npm, fournit `tsci`/`tscircuit` via `cli.mjs`) | `0.0.3047` | https://registry.npmjs.org/tscircuit/latest |
| `@tscircuit/cli` (dépendance de `tscircuit`) | `^0.1.2427` (pin `0.1.2427` dans `tscircuit@0.0.3047`) | https://registry.npmjs.org/tscircuit/latest + https://raw.githubusercontent.com/tscircuit/cli/main/package.json |
| `@tscircuit/runframe` | `0.0.3113` | https://registry.npmjs.org/@tscircuit%2Frunframe/latest |
| `@tscircuit/props` | `0.0.715` | https://registry.npmjs.org/@tscircuit%2Fprops/latest |
| `@tscircuit/footprinter` | `0.0.450` | https://registry.npmjs.org/@tscircuit%2Ffootprinter/latest |
| `@tscircuit/capacity-autorouter` (autorouter builtin) | `^0.0.1018` (range consommée par `core`/`eval`) | https://raw.githubusercontent.com/tscircuit/core/main/package.json |

Licences (toutes MIT-compatibles) :

- `core` : MIT — https://raw.githubusercontent.com/tscircuit/core/main/LICENSE ; `eval` : MIT (README + `MIT license`, https://github.com/tscircuit/eval) ; `cli` : MIT — https://raw.githubusercontent.com/tscircuit/cli/main/LICENSE ; `tscircuit` npm : `license: MIT` — https://registry.npmjs.org/tscircuit/latest ; `capacity-autorouter` : MIT (« A State of the Art MIT-licensed PCB Autorouter », https://github.com/tscircuit/capacity-autorouter) ; `props` : ISC — https://registry.npmjs.org/@tscircuit%2Fprops/latest ; `footprinter` : ISC — https://registry.npmjs.org/@tscircuit%2Ffootprinter/latest. Tauri v2 lui-même : CC-BY / MIT (footer https://v2.tauri.app/develop/sidecar/).

## 2. API exacte `@tscircuit/core` sans React

- Entrée publique : https://raw.githubusercontent.com/tscircuit/core/main/lib/index.ts ré-exporte `./RootCircuit`, `./IsolatedCircuit`, `./IRootCircuit`, `./IIsolatedCircuit`, `./components`, `./solvers`, etc.
- `RootCircuit` : https://raw.githubusercontent.com/tscircuit/core/main/lib/RootCircuit.ts — `export class RootCircuit extends IsolatedCircuit`, alias `export const Circuit = RootCircuit` (et `Project` déprécié).
- Cycle de vie (vérifié) : https://raw.githubusercontent.com/tscircuit/core/main/lib/IsolatedCircuit.ts — `add(componentOrElm)` (React element ou `PrimitiveComponent`), `async renderUntilSettled(): Promise<void>`, `getCircuitJson(): AnyCircuitElement[]` (alias `toJson()`), `isDoneRendering()`, events `asyncEffect:start/end`, `renderComplete`.
- Usage sans React (source : https://github.com/tscircuit/core, section « Non-React Usage ») :
  `import { Board, Resistor, Led, Trace, Circuit } from "@tscircuit/core"` puis `new Circuit()`, `new Board({width,height})`, `board.add(...)`, `circuit.getCircuitJson()`.
- Config thread autorouting côté lib : https://raw.githubusercontent.com/tscircuit/core/main/docs/autorouter-threads.md + https://raw.githubusercontent.com/tscircuit/cli/main/docs/autorouter-threads.md — `new RootCircuit({ platform: { autorouterThreads: 4 } })`, `solveAsync` worker-backed sur Node/Bun, `solveSync()` reste inline. Navigateur = inline.

## 3. API `@tscircuit/eval` (lib, worker, blob-url offline)

- Entrées : https://raw.githubusercontent.com/tscircuit/eval/main/lib/index.ts → `./runner`, `./worker`, `getPlatformConfig`, etc. ; https://github.com/tscircuit/eval (README).
- `runTscircuitCode(fsMap | codeString, opts?)` : https://raw.githubusercontent.com/tscircuit/eval/main/lib/runner/runTscircuitCode.ts — exige `export` dans le code, construit `CircuitRunner`, `executeWithFsMap` + `renderUntilSettled` + `getCircuitJson`.
- `CircuitRunner` : https://raw.githubusercontent.com/tscircuit/eval/main/lib/runner/CircuitRunner.ts — `execute(code)`, `executeWithFsMap({entrypoint, fsMap, name, ...})`, `executeComponent(c)`, `renderUntilSettled()`, `getCircuitJson()`, `setPlatformConfig / setPlatformConfigProperty / setProjectConfig(Property) / setSnippetsApiBaseUrl / setDisableCdnLoading / setTscircuitSessionToken / setEasyEdaProxyConfig / setPartsEngineOptions / enableDebug`, events `on(...)`.
- `WebWorker` : https://raw.githubusercontent.com/tscircuit/eval/main/lib/worker.ts — `createCircuitWebWorker(configuration: Partial<WebWorkerConfiguration>)`, `getWebWorkerEntrypointCdnUrls(evalVersion)`, `fetchWebWorkerEntrypointBlobFromCdn(...)`. Sans `webWorkerBlobUrl`, le worker est fetché depuis `https://jscdn.tscircuit.com/@tscircuit/eval/<ver>/dist/webworker/entrypoint.js` puis fallback `cdn.jsdelivr.net`, `unpkg` (preuve offline : il faut fournir le blob local).
- `WebWorkerConfiguration` : https://raw.githubusercontent.com/tscircuit/eval/main/lib/shared/types.ts — `snippetsApiBaseUrl` (défaut `https://registry-api.tscircuit.com`), `cjsRegistryUrl` (défaut `https://cjs.tscircuit.com`), `webWorkerBlobUrl`, `disableCdnLoading`, `enableFetchProxy`, `tscircuitSessionToken`, `platform/projectConfig`.
- Worker runtime : https://raw.githubusercontent.com/tscircuit/eval/main/webworker/entrypoint.ts — Comlink `expose`, `executionContext = createExecutionContext(...)`, `importEvalPath`, `getTsConfig`, `loadTscircuitConfig`, `getPlatformConfigForTscircuitConfig`. Transpile : Sucrase (`transformWithSucrase`), exposé via https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/index.ts.
- Blob-url offline : https://raw.githubusercontent.com/tscircuit/eval/main/scripts/build-worker-blob-url.ts — base64 du `dist/webworker/entrypoint.js` → `dist/blob-url.js` (`export default blobUrl`). Usage préconisé : `import evalWebWorkerBlobUrl from "@tscircuit/eval/blob-url"` (https://github.com/tscircuit/runframe, section « Providing the Blob URL (to avoid loading webworker from CDN) »). Dans Tauri (WebView), préférer `webWorkerBlobUrl: <asset local bundlé>` + `disableCdnLoading` selon besoin, plutôt que le fetch CDN par défaut.

## 4. Autorouter : local par défaut, cloud opt-in (stratégie offline)

- Presets et défaut local : https://raw.githubusercontent.com/tscircuit/core/main/lib/utils/autorouting/getPresetAutoroutingConfig.ts — `defaults = { serverUrl: "https://registry-api.tscircuit.com", serverMode: "job", serverCacheEnabled: true }` ; `default`/`auto`/`auto-local`/`subcircuit`/`fanout`/`bus_lanes`/`dogbone`/`simplify`/`laser_prefab` retournent `local: true` ; seul `auto-cloud` retourne `local: false` (+ `defaults`). Objet sans `preset` : `local: !(serverUrl||serverMode||serverCacheEnabled)`.
- `PlatformConfig` : https://raw.githubusercontent.com/tscircuit/props/main/lib/platformConfig.ts — `useCloudAutorouter?: boolean` (« Omitted or false keeps local routing »), `cloudAutorouterUrl?: string`, `autorouter?: AutorouterProp`, `autorouterMap?`, `autorouterThreads?: number` (>1 = workers locaux, 1 = inline, navigateur mono-thread), `allowLegacyAutorouters?`, `localCacheEngine?`.
- Threads/cache locaux : https://raw.githubusercontent.com/tscircuit/cli/main/docs/autorouter-threads.md + https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/get-platform-config-with-cli-defaults.ts — défaut CLI `autorouterThreads: 4` (sauf Bun <1.4.2 → 1), `localCacheEngine` sur `<project>/.tscircuit/cache`, `platformFetch` wrappé (`TSCIRCUIT_BAKED_ASSET_SERVER_BASE_URL` pour builds standalone). Core doc : https://raw.githubusercontent.com/tscircuit/core/main/docs/autorouter-threads.md.
- Exemple custom cloud (docs) : https://docs.tscircuit.com/elements/board — `autorouter={{ serverUrl: "https://api.tscircuit.com", serverMode: "job", inputFormat: "simplified" }}`. Écart d'hôte constaté : code défaut `registry-api.tscircuit.com`, exemple docs `api.tscircuit.com` (voir Incertitudes).
- Autorouter builtin : https://github.com/tscircuit/capacity-autorouter — `AutoroutingPipelineSolver(simpleRouteJson)`, `step()` / `solveAsync` / `getOutputSimpleRouteJson()`, `SimpleRouteJson { layerCount, obstacles, connections, bounds, traces? }`. Interface locale : https://raw.githubusercontent.com/tscircuit/core/main/lib/utils/autorouting/GenericLocalAutorouter.ts.
- Docs CLI debug (utile sidecar) : https://github.com/tscircuit/cli (README) — `--autorouter-debug`, `--autorouter-dump-srj all|failed|phase:N`, `--autorouter-phase`, `--solver-debug`, `tsci report autorouter`.

## 5. Résolution `@tsci/*`, CDN, caches

- `@tsci/*` = registre compilé, pas jsDelivr direct : https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/import-snippet.ts — `fullSnippetName = importName.replace("@tsci/","").replace(".","/")`, `fetch(${cjsRegistryUrl}/${fullSnippetName})` avec `cjsRegistryUrl` par défaut `https://cjs.tscircuit.com` (cf. `CircuitRunner.ts`, `webworker/entrypoint.ts`). Dép. transitives via `getImportsFromCode`, assets statiques via `https://cjs.tscircuit.com/@tsci/<author.package>/<asset>`, token éventuel `Authorization: Bearer <tscircuitSessionToken>` (packages privés, cf. commentaire `npm.tscircuit.com` dans `types.ts`).
- Paquets npm génériques : https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/import-npm-package-from-cdn.ts + https://raw.githubusercontent.com/tscircuit/eval/main/lib/utils/npm-cdn-urls.ts — ordre `https://jscdn.tscircuit.com/<pkg>/<ver>/+esm` puis `https://cdn.jsdelivr.net/npm/<pkg>/+esm` (`JSCDN_ORIGIN = "https://jscdn.tscircuit.com"`).
- Footprints KiCad : https://raw.githubusercontent.com/tscircuit/eval/main/lib/getPlatformConfig/getPlatformConfig.ts — `footprintLibraryMap.kicad` fetch `https://kicad-mod-cache.tscircuit.com/<name>.circuit.json` (+ `.wrl`/`.step` pour CAD), `jlcpcb` via `partsEngine.fetchPartCircuitJson`.
- Config plateforme fusionnée : https://raw.githubusercontent.com/tscircuit/eval/main/lib/getPlatformConfig/getPlatformConfigForTscircuitConfig.ts (fusion `tscircuit.config` + `platform`/`projectConfig`).

## 6. `tsci` sidecar : commandes réellement existantes, exports, poids

- Commandes (source : https://github.com/tscircuit/cli, `Usage: tsci [options] [command]`) : `init, dev, clone, push, auth/login/logout, config, export, build, transpile, add, agent, remove, snapshot, setup, install, update, upgrade, doctor, report, check, registry, search, import, convert, simulate, version`.
- `build` : https://raw.githubusercontent.com/tscircuit/cli/main/cli/build/register.ts — `tsci build [file]`, flags vérifiés : `--ignore-errors`, `--ignore-warnings`, `--ignore-netlist-drc`, `--ignore-pin-specification-drc`, `--ignore-placement-drc`, `--ignore-routing-drc`, `--disable-pcb`, `--routing-disabled`, `--disable-parts-engine`, `--site/--bundle-jscdn/--jscdn-base-url`, `--transpile`, `--preview-images/--all-images`, `--pngs/--pcb-png/--schematic-png/--svgs/--pcb-svgs/--schematic-svgs/--simulation-svgs/--3d/--3d-png`, `--kicad-project(-zip)/--kicad-library/--kicad-pcm`, `--concurrency`, `--inject-props(-file)`, `--autorouter-*`, `--solver-debug*`, `--profile`, `--ci`. Sortie `dist/**/circuit.json`.
- `export` : https://raw.githubusercontent.com/tscircuit/cli/main/cli/export/register.ts + https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/export-snippet.ts + https://docs.tscircuit.com/command-line/tsci-export — `tsci export <file> -f <format> -o <path>`. `ALLOWED_EXPORT_FORMATS` (22) : `json, circuit-json, drawing-svg, schematic-svg, schematic-pdf, pcb-svg, pcb-png, gerbers, readable-netlist, gltf, glb, specctra-dsn, kicad_sch, kicad_pcb, kicad_zip, altium, kicad-library, srj, step, assembly-svg, assembly-step, component-box-3mf`. `-f gerbers` produit zip + `bom.csv` + `pick_and_place.csv`.
- `snapshot` : https://raw.githubusercontent.com/tscircuit/cli/main/cli/snapshot/register.ts — `tsci snapshot [path] [--update] [--force-update] [--3d] [--pcb-only] [--schematic-only] [--simulation-only] [--layer top|bottom] [--camera-preset] [--ci] [--test] [--concurrency]`. Référence `--3d` conforme à la question.
- `check` : https://raw.githubusercontent.com/tscircuit/cli/main/cli/check/register.ts — `tsci check [file]`, « Partially build and validate circuit artifacts ».
- `init` : https://raw.githubusercontent.com/tscircuit/cli/main/cli/init/register.ts — `tsci init [directory] [-y] [--no-install]` ; écrit `index.circuit.tsx` (exemple R1/C1/trace, voir §8), `.npmrc` (`@tsci:registry=https://npm.tscircuit.com`), `package.json` (via https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/generate-package-json.ts), `tsconfig.json` (via https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/generate-ts-config.ts), `.gitignore`, skill, puis `setupTsciProject`. Docs : https://docs.tscircuit.com/intro/quickstart-cli (montre `index.tsx` — variante de nom, voir Incertitudes).
- Poids : `tscircuit@0.0.3047` `unpackedSize: 73122068` (~73 Mo) — https://registry.npmjs.org/tscircuit/latest ; `core` `unpackedSize: 17413789` (~17,4 Mo) — https://registry.npmjs.org/@tscircuit%2Fcore/latest ; `eval` `unpackedSize: 67379089` (~67 Mo) — https://registry.npmjs.org/@tscircuit%2Feval/latest. Build CLI : https://raw.githubusercontent.com/tscircuit/cli/main/scripts/bun-build.ts (`bun build cli/main.ts + workers → dist/`, deps `tscircuit` externalisées sauf allow-list, `runframe/standalone` copié). Pas de binaire `tsci` prébuilt mult Triple versionné constaté dans les sources : le sidecar Tauri suppose un build/bundling par l'app (voir §7).

## 7. Déclaration sidecar Tauri (v2)

- `externalBin` : https://v2.tauri.app/develop/sidecar/ — `tauri.conf.json > bundle.externalBin: ["binaries/my-sidecar"]` (chemins relatifs à `src-tauri/`), binaire réel exigé avec suffixe `-<TARGET_TRIPLE>` (`my-sidecar-x86_64-unknown-linux-gnu`, `my-sidecar-aarch64-apple-darwin`, … ; triple via `rustc --print host-tuple`).
- Rust : `app.shell().sidecar("my-sidecar")` (nom seul, pas le chemin), `spawn()`/`write()` (nécessite `tauri_plugin_shell::init()`).
- JS : `import { Command } from '@tauri-apps/plugin-shell'`, `Command.sidecar('binaries/my-sidecar')`, `.execute()`.
- Capabilities : `src-tauri/capabilities/default.json` — `shell:allow-execute` (ou `allow-spawn`) avec `{ "name": "binaries/<nom>", "sidecar": true, "args": [...] }` ; args statiques tels quels, dynamiques via `{ "validator": "\\S+" }`. Référence permissions : https://v2.tauri.app/plugin/shell/.

## 8. Format projet standard proposé (imposable à l'agent)

Base vérifiée : `tsci init` (register + generators), `examples/scaffold/package.json` (https://raw.githubusercontent.com/tscircuit/cli/main/examples/scaffold/package.json), détection entrypoint (https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/get-entrypoint.ts : `index.tsx|index.ts|index.circuit.tsx|main.tsx|main.circuit.tsx`, `lib/`/`src/` variantes, `tscircuit.config` prioritaire), schéma config (https://raw.githubusercontent.com/tscircuit/cli/main/lib/project-config/project-config-schema.ts), props board (https://docs.tscircuit.com/elements/board + https://raw.githubusercontent.com/tscircuit/props/main/lib/components/board.ts), groupe/layout (`pcbX/pcbY/pcbFlex…`, https://raw.githubusercontent.com/tscircuit/props/main/lib/components/group.ts), `resistor` (`name/footprint/resistance`, https://docs.tscircuit.com/elements/resistor), footprints (`0402`, `0603`, `soic8_p1.27mm`…, https://github.com/tscircuit/footprinter).

Arborescence imposée :

```text
<projet>/
  package.json            # name `@tsci/<handle>.<slug>`, main entrypoint, scripts dev/build/snapshot, devDeps tscircuit+typescript
  index.tsx               # entrypoint unique (alias acceptés : index.circuit.tsx) — voir exemple ci-dessous
  tscircuit.config.json   # mainEntrypoint + includeBoardFiles + snapshotsDir (+ useCloudAutorouting=false explicite)
  tsconfig.json           # jsx react-jsx, types ["tscircuit"]
  .npmrc                  # @tsci:registry=https://npm.tscircuit.com
  .gitignore
  manual-edits.json       # généré par `tsci dev`, commité (edit events)
  dist/                   # généré, ignoré
  tests/__snapshots__/    # snapshots `tsci snapshot`, versionnés
```

`package.json` minimal (générateur : `generate-package-json.ts`) :

```json
{
  "name": "@tsci/<handle>.<slug>",
  "version": "1.0.0",
  "description": "A tscircuit component package",
  "main": "index.tsx",
  "keywords": ["tscircuit", "circuit", "pcb", "electronics"],
  "scripts": {
    "dev": "tsci dev",
    "build": "tsci build",
    "snapshot": "tsci snapshot",
    "snapshot:update": "tsci snapshot --update",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "tscircuit": "latest", "typescript": "^5.0.0" }
}
```

`tscircuit.config.json` minimal :

```json
{
  "mainEntrypoint": "index.tsx",
  "includeBoardFiles": ["**/*.circuit.tsx"],
  "snapshotsDir": "tests/__snapshots__",
  "useCloudAutorouting": false
}
```

Exemple `index.tsx` minimal valide (conforme au template `init`, adapté à l'entrypoint `index.tsx`) :

```tsx
export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-4} pcbY={0} />
    <capacitor name="C1" capacitance="1000pF" footprint="0402" pcbX={4} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".C1 > .pin1" />
    <trace from=".C1 > .pin2" to="net.GND" />
  </board>
)
```

Règles de validation imposables à l'agent (MCP thin : valider avant `build`) :

1. Fichiers requis : `package.json` (`name` `/^@tsci\/[a-z0-9-]+\.[a-z0-9-]+$/`, `main` pointe un fichier existant), entrypoint existant, `tscircuit.config.json`, `tsconfig.json` (`jsx: react-jsx`).
2. Racine : un seul `<board width height>` (nombres ou `"20mm"`), `layers` ∈ `1|2|4|6|8|10` si présent, `material` ∈ `fr4|fr1|flex` si présent (défauts `fr4`/2 couches).
3. Composants : `name` unique et préfixé (`R*`, `C*`, `L*`, `D*`, `Q*`, `U*`, `J*`), `footprint` obligatoire et non vide (string footprinter `0402`… ou `kicad:`/`jlcpcb:` — pas de pastille nue), `resistance`/`capacitance` typés (string avec unité ou number).
4. Placement : si `pcbX`/`pcbY` fournis, nombres (mm) dans `[-width/2, width/2]` ; `pcbFlex`/`pcbGrid` réservés aux conteneurs ; pas de mélange incohérent `sch*`/`pcb*` bloquant (warning).
5. Connectivité : toute `trace` a `from`+`to` (ou `path`), sélecteurs valides (`.R1 > .pin1`, `net.VCC`), nets `VCC/GND` déclarés ou implicites autorisés, aucun composant flottant sans trace (warning → erreur si `routingDisabled` faux et DRC `netlist`).
6. Interdits : `autorouter="auto_cloud"` / `useCloudAutorouter: true` sans drapeau explicite offline-override ; imports hors `@tsci/*` + relatifs + npm déclarés (résolution `package.json`).
7. Sorties : `tsci build` (ou lib `renderUntilSettled` + `getCircuitJson`) sans erreur, `tsci check` propre, `tsci snapshot` à jour si `tests/__snapshots__` versionné.

## 9. Stratégie offline concrète (Tauri)

Bundler (dans l'app, pas de fetch au premier rendu) :

- `dist/webworker/entrypoint.js` de `@tscircuit/eval` via `@tscircuit/eval/blob-url` → `webWorkerBlobUrl` passé à `createCircuitWebWorker` (preuve §3). Pinner `evalVersion` = version embarquée.
- `core` + `props` + `footprinter` + `capacity-autorouter` + `krt-wasm` en dépendances bundlées (pas de `latest` flottant en prod ; `checkForTsciUpdates`/`alwaysUseLatestTscircuitOnCloud` désactivés en offline).
- `runframe/standalone` uniquement si l'app réutilise la visionneuse ; sinon `circuit-to-svg`/`pcb-viewer` suffit (le CLI bundle déjà `standalone.min.js` pour `--site`, cf. `bun-build.ts`).

Cacher (persistant, invalidable) :

- `localCacheEngine` → profil Tauri (`appDataDir/.tscircuit/cache`) : SimpleRouteJson/routes (`serverCacheEnabled` local), `jscdn` tgz (`--bundle-jscdn` / `TSCIRCUIT_JSCDN_DIR` côté sidecar), `cjs.tscircuit.com` (`@tsci/*`), `kicad-mod-cache.tscircuit.com`, `registry-api` metadata. Réutiliser `.tscircuit/cache` du CLI pour compatibilité sidecar.
- Snapshots `tests/__snapshots__` + `dist/**/circuit.json` versionnés/cachés pour démarrage instantané et diff `--ci`.

Fallback si API injoignable (ordre imposé) :

1. Forcer `platform: { useCloudAutorouter: false, autorouter: "auto-local", autorouterThreads: 4 }`, `partsEngineDisabled` ou moteur local, `checkAvailability: false`.
2. Servir les caches ci-dessus ; si miss, erreur explicite « Pièce/empreinte non disponible hors-ligne » (pattern `BakedAssetNotFoundError` de `get-platform-fetch.ts`) au lieu d'un timeout silencieux.
3. `routingDisabled: true` en mode dégradé (placement/schématique visibles, ratsnest), puis relancer le routage à la reconnexion.
4. Sidecar `tsci` (si embarqué) avec `TSCIRCUIT_BAKED_ASSET_SERVER_BASE_URL` + `--bundle-jscdn` et mêmes caches disque.

## 10. Recommandation opérationnelle (thin MCP)

- **Phase 1 (lib seule) :** outils MCP `project.validate` (règles §8), `circuit.build` (`CircuitRunner.executeWithFsMap` en Worker blob-local → `circuit.json`), `circuit.check` (diagnostics), `circuit.export` (SVG/PNG/Gerber via `circuit-json-to-*` déjà dans `tscircuit`), `circuit.snapshot` (PNG/SVG comparés). Aucun process externe, cold-start minimal, offline total après install.
- **Phase 2 (sidecar opt-in) :** `tsci` en `externalBin` triplé pour `build --site`, `export altium/kicad_zip/step/glb`, `snapshot --ci`, `report`. Capabilities `shell:allow-execute`/`allow-spawn` verrouillées (`sidecar: true`, args allow-list). Ne pas en faire le chemin critique : le driver agent doit pouvoir finir un board sans sidecar.

## 11. Incertitudes restantes (à lever par le driver, pas bloquantes)

1. Hôte cloud exact : `registry-api.tscircuit.com` (défaut code `getPresetAutoroutingConfig`) vs `api.tscircuit.com` (exemple docs `board`). Impact : pinner `cloudAutorouterUrl`/`serverUrl` si le mode cloud est un jour activé.
2. Nom d'entrypoint `init` : code écrit `index.circuit.tsx`, docs/quickstart et `scaffold` utilisent `index.tsx`. Impact : accepter les deux (comme `get-entrypoint.ts`) et normaliser sur `index.tsx` dans le format §8.
3. Taille réelle du binaire `tsci` par triple (Linux/Win/macOS) non mesurée ici (sources = build `bun` local, pas d'artefact versionné) ; ordre de grandeur borne haute = ~73 Mo npm + runtime Bun. À mesurer au packaging Tauri.
4. Couverture exacte du `BakedAssetServer` (`TSCIRCUIT_BAKED_ASSET_SERVER_BASE_URL`) et du cache `jscdn` pré-packagé : documentés côté CLI mais sans inventaire de pièces — à valider par test offline réel (`--bundle-jscdn` + coupure réseau).
5. `pcbFlex` demandé dans la question : propriété de conteneur (`BaseGroupProps.pcbFlex*` dans `group.ts`), pas une prop de composant feuille ; la règle §8 la restreint aux conteneurs — à confirmer contre le linter cible si l'agent doit placer en flex absolu.

## Sources (primaires, vérifiées le 2026-11-01)

- https://github.com/tscircuit/core (README : `Circuit`, usage non-React)
- https://raw.githubusercontent.com/tscircuit/core/main/package.json , https://registry.npmjs.org/@tscircuit%2Fcore/latest
- https://raw.githubusercontent.com/tscircuit/core/main/lib/index.ts , https://raw.githubusercontent.com/tscircuit/core/main/lib/RootCircuit.ts , https://raw.githubusercontent.com/tscircuit/core/main/lib/IsolatedCircuit.ts , https://raw.githubusercontent.com/tscircuit/core/main/docs/autorouter-threads.md
- https://raw.githubusercontent.com/tscircuit/core/main/lib/utils/autorouting/getPresetAutoroutingConfig.ts , https://raw.githubusercontent.com/tscircuit/core/main/lib/utils/autorouting/GenericLocalAutorouter.ts
- https://github.com/tscircuit/eval (README : `runTscircuitCode`, `CircuitRunner`, `createCircuitWebWorker`, `executeWithFsMap`, `runTscircuitModule`, CDN import map)
- https://raw.githubusercontent.com/tscircuit/eval/main/package.json , https://registry.npmjs.org/@tscircuit%2Feval/latest
- https://raw.githubusercontent.com/tscircuit/eval/main/lib/index.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/runner/CircuitRunner.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/runner/runTscircuitCode.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/shared/types.ts , https://raw.githubusercontent.com/tscircuit/eval/main/webworker/entrypoint.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/worker.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/index.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/import-snippet.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/import-npm-package-from-cdn.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/utils/npm-cdn-urls.ts , https://raw.githubusercontent.com/tscircuit/eval/main/scripts/build-worker-blob-url.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/getPlatformConfig/getPlatformConfig.ts , https://raw.githubusercontent.com/tscircuit/eval/main/lib/getPlatformConfig/getPlatformConfigForTscircuitConfig.ts
- https://github.com/tscircuit/cli (README : commandes, `build --ignore-*`, `--autorouter-*`, `--solver-debug`)
- https://raw.githubusercontent.com/tscircuit/cli/main/package.json , https://registry.npmjs.org/tscircuit/latest
- https://raw.githubusercontent.com/tscircuit/cli/main/cli/init/register.ts , https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/generate-package-json.ts , https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/generate-ts-config.ts , https://raw.githubusercontent.com/tscircuit/cli/main/examples/scaffold/package.json (via `examples/scaffold/package.json`)
- https://raw.githubusercontent.com/tscircuit/cli/main/cli/build/register.ts , https://raw.githubusercontent.com/tscircuit/cli/main/cli/export/register.ts , https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/export-snippet.ts , https://raw.githubusercontent.com/tscircuit/cli/main/cli/snapshot/register.ts , https://raw.githubusercontent.com/tscircuit/cli/main/cli/check/register.ts , https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/get-entrypoint.ts , https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/get-platform-config-with-cli-defaults.ts , https://raw.githubusercontent.com/tscircuit/cli/main/lib/shared/get-platform-fetch.ts , https://raw.githubusercontent.com/tscircuit/cli/main/lib/project-config/project-config-schema.ts , https://raw.githubusercontent.com/tscircuit/cli/main/docs/autorouter-threads.md , https://raw.githubusercontent.com/tscircuit/cli/main/scripts/bun-build.ts
- https://github.com/tscircuit/runframe (README : `RunFrame`, blob-url offline) , https://registry.npmjs.org/@tscircuit%2Frunframe/latest
- https://github.com/tscircuit/capacity-autorouter (README : MIT, Pipeline, SimpleRouteJson)
- https://github.com/tscircuit/footprinter (README : DSL, `0402`/`soic8_p1.27mm`…) , https://registry.npmjs.org/@tscircuit%2Ffootprinter/latest
- https://raw.githubusercontent.com/tscircuit/props/main/lib/platformConfig.ts , https://raw.githubusercontent.com/tscircuit/props/main/lib/components/group.ts , https://raw.githubusercontent.com/tscircuit/props/main/lib/components/board.ts , https://registry.npmjs.org/@tscircuit%2Fprops/latest
- https://docs.tscircuit.com , https://docs.tscircuit.com/intro/quickstart-cli , https://docs.tscircuit.com/command-line/tsci-export , https://docs.tscircuit.com/elements/board , https://docs.tscircuit.com/elements/resistor
- https://v2.tauri.app/develop/sidecar/ (externalBin, triple, Rust/JS, capabilities) , https://v2.tauri.app/plugin/shell/ (permissions `shell:allow-execute/spawn`)
