# PROTOTYPE JETABLE — preview-web (ticket wayfinder #5)

> Ne pas merger dans `main`. Ne pas réutiliser en prod (aucun test, aucun polish,
> état 100 % en mémoire, aucune persistance).

## Question du ticket

`runframe` seul vs viewers séparés bundlés ; contrat screenshot agent ; CSP offline-first.

Décisions d'entrée (tickets #2/#3 fermés, voir `docs/research/pipeline-tscircuit-tauri.md`) :
pipeline = `@tscircuit/core 0.0.2245` + `@tscircuit/eval 0.0.1681` en WebWorker
avec blob-url bundlé (offline-first). Versions évaluées ici : runframe `0.0.3113`,
props `0.0.715`, schematic-viewer `2.0.x`, pcb-viewer `1.11.x`, 3d-viewer `0.0.x`.

## Lancer (une commande)

```sh
cd prototype/preview-web && npm install && npm run dev
```

puis ouvrir :

- Variante A (runframe seul) : http://localhost:5173/?view=runframe
- Variante B (viewers séparés) : http://localhost:5173/?view=viewers

La barre flottante en bas (←/→, clavier supporté) change de variante en réécrivant `?view=`.

## Contenu

- `?view=runframe` — `<RunFrame>` seul (`fsMap` + `evalWebWorkerBlobUrl` bundlé).
- `?view=viewers` — `SchematicViewer` / `PCBViewer` (`CadViewer`) séparés, onglets
  Schéma/PCB/3D, alimentés par UNE compile partagée (core+eval en WebWorker blob-local).
- Board d'exemple : diviseur de tension R1/R2 + 1 puce SOT-23 U1
  (`src/lib/board.ts`, props name/footprint/pcbX-pcbY imposées).
- Surface d'état partout : stats circuit-json (composants/traces/nets + détail par type),
  logs compile, mode (`worker-blob-local` / `inline-maintenance` / `echec`).
- Bouton **« Screenshot agent »** : capture canvas/SVG → PNG dataURL, affiche la taille
  base64 et propose le download. Contrat simulé : `schematique_2d` / `pcb_2d` / `pcb_3d`
  selon l'onglet (variante B) ou la vue active runframe (variante A → `pcb_2d`).
- Case `disableCdnLoading` : simule l'offline strict. Si le bundling bloque, dégradation
  propre avec bandeau **« RÉSEAU REQUIS pour X »** (jamais de circuit-json inventé).
- CSP : volontairement ABSENTE en dev (question ouverte du ticket — voir verdict du
  commit). Exemple à trancher pour la WebView Tauri :
  `<!-- <meta http-equiv="Content-Security-Policy" content="default-src 'self'; worker-src 'self' blob:; ..."> -->`

## Résultats constatés (validation headless + headed Chrome, 2026-11-01)

- Compile partagée : `worker-blob-local`, **92 éléments** (13 composants / 14 traces /
  5 nets), ~3–8 s en navigateur réel, 0 erreur. Board : R1/R2 + U1 (sot23), autorouté
  (`pcb_trace:4`, `pcb_via:2` — vérifié en Node).
- `disableCdnLoading` coché : `worker-blob-local-nocdn`, 92 éléments + bandeau
  (footprints 0402/sot23 générés localement, pas de CDN requis pour ce board).
- Variante A (runframe) : onglets PCB/Schematic/3D internes, compile propre,
  screenshot canvas 1254×426 (~12 Ko base64) + download.
- Variante B (viewers) : schéma SVG rendu (R1/R2 + U1 + VCC), screenshot SVG→PNG
  1238×612 (~33 Ko base64) + download. Contrat `schématique_2d/pcb_2d/pcb_3d` OK.
- Limites environnement (pas des bugs prototype) : sans GPU, PCBViewer/3D affichent
  « WebGPU rendering failed » (screenshot agent pcb_2d/pcb_3d doit prévoir le
  fallback) ; `get-supplier-part-numbers` est l'étape lente → `partsEngineDisabled`
  dans le prototype (question offline : quelles pièces pré-bundler).
- Trouvaille API : un entrypoint `export default` exige `mainComponentPath` SANS
  `entrypoint` (sinon « IsolatedCircuit has no children ») — cf. `compile.ts`.

## Notes de construction (honêtes)

- `overrides: { "@tscircuit/jscad": "0.0.6" }` : `jscad-fiber` (chaîne du 3d-viewer)
  dépend d'un tarball `https://jscdn.tscircuit.com/…tgz` refusé par npm ici
  (`EALLOWREMOTE`) ; on force la version registre. À revoir si la 3D casse.
- `npm install --legacy-peer-deps` requis (conflits de peers React dans la chaîne viewers).
- Deps non déclarées par les builds publiés (ajoutées à la main dans `package.json`,
  sinon `vite build` échoue sur imports non résolus) : `ky`, `fuse.js`, `jszip`,
  `react-error-boundary`, `cmdk`, `lucide-react`, `minimatch`, `comlink`, `debug`,
  `marked`, `posthog-js`, `react-query`, `tailwind-merge`, `class-variance-authority`,
  radix divers, `circuit-json-to-*`, `sucrase`, `schematic-symbols`, `graphics-debug`,
  `kicad-to-circuit-json`, `kicadts`, `@tscircuit/*` (solvers…), `bpc-graph`,
  `connectivity-map`, `minicssgrid`, `spicets`, `spicey`, `@tscircuit/krt-wasm`,
  `@resvg/resvg-wasm`. Poids/fragilité du bundling runframe : point du verdict.
- `vite.config.ts` alise deux modules non bundlables vers des stubs qui échouent
  proprement si appelés (hors question du ticket) :
  `circuit-json-to-altium` (dep github-only du build runframe, export Altium simulé
  absent) et `@resvg/resvg-js` (binaire natif Node, usage upstream = branche `isNode`
  uniquement). Voir `src/lib/altium-stub.ts`, `src/lib/resvg-stub.ts`.
- `@tscircuit/footprinter` bumpé à `0.0.450` et `@tscircuit/circuit-json-util` à
  `0.0.129` (versions exigées par `core 0.0.2245` ; l'arbre hoisté plus ancien cassait
  le build sur exports manquants).
- Le blob-url eval pèse ~25 Mo : `npm run dev` / `vite build` sont lents, c'est le
  coût offline-first. Le build exige un heap Node étendu (`NODE_OPTIONS`, déjà
  dans le script `build` — OOM constaté à 2 Go par défaut).
- `dist/` est généré par `npm run build` (git-ignoré) ; seule la source est commitée.
