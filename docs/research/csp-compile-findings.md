# Compile CSP : trancher unsafe-eval ciblé (A) vs pré-bundling sans eval (B) — findings wayfinder (ticket #21)

- Date : 2026-11-02. Repo : `Marwichmisi/nia-tscript`. Branche jetable : `research/csp-compile` (jamais mergée).
- Question ticket : build installé échoue avec `Refused to evaluate a string as JavaScript because 'unsafe-eval' … script-src 'self' 'wasm-unsafe-eval'` quand `src/src/lib/compile.ts:33-37` appelle `createCircuitWebWorker` avec blob-url bundlé, puis tombe en repli inline qui exige le CDN.
- Méthode (skill `research`) : sources primaires uniquement — code installé `src/node_modules/@tscircuit/eval@0.0.1681/dist/*`, source amont `tscircuit/eval` (raw GitHub), MDN `script-src`, réf config Tauri v2. Versions vérifiées le jour même.

## Verdict : option A — ajouter `'unsafe-eval'` au `script-src` Tauri (B écarté, sauf variante fixture-only sans avenir)

Diff proposée (non appliquée sur cette branche, preuve à faire sur build installé) :

```diff
-        "script-src": "'self' 'wasm-unsafe-eval'",
+        "script-src": "'self' 'wasm-unsafe-eval' 'unsafe-eval'",
```

`worker-src`, `connect-src`, `style-src` inchangés. Le reste du verdict explique pourquoi « ciblée + sha256 » est une illusion pour ce cas, et pourquoi B ne peut pas suffire.

## 1. Preuve : deux `new Function` distincts, pas un

### 1a. Le chemin user-code : `evalCompiledJs` → `Function(...)`

- Amont (source qui fait foi) : `lib/eval/eval-compiled-js.ts` (https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/eval-compiled-js.ts) construit `functionBody` (`var exports…; var require…; ${compiledCode}; return module`) puis **`return Function(functionBody).call(globalThis)`**.
- Installé (vérifié localement) : ce code est inliné dans `src/node_modules/@tscircuit/eval/dist/eval/index.js` **et** dans `dist/webworker/entrypoint.js` (le blob-url de 19 Mo). Donc même le chemin « worker blob-url bundlé, offline-first » exécute le TSX compilé par Sucrase via le constructeur `Function` — Sucrase ne fait que transpiler (pur JS, pas d'eval), l'exécution passe toujours par `Function(...)`.
- MDN `script-src` (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src, § Unsafe eval expressions) : sans `'unsafe-eval'`, `Function()` est bloqué. C'est exactement le message du ticket. `'wasm-unsafe-eval'` ne couvre **que** la compilation/instanciation WebAssembly, pas `eval`/`Function` (§ Unsafe WebAssembly execution : « more specific than 'unsafe-eval' »). CQFD : `wasm-unsafe-eval` seul ne pourra jamais débloquer ce chemin.

### 1b. Le chemin WASM : Emscripten embind utilise `new Function`

- Installé (vérifié localement, `dist/webworker/entrypoint.js`) : 2 occurrences `new Function(...)` dans du glue Emscripten (`craftInvokerFunction`, `emval_addMethodCaller` — 51 occurrences `emval`, `manifold.wasm`, `krt-wasm`, solvers `@tscircuit/*-solver` présents dans le même bundle).
- Conséquence : même si on éliminait `Function(...)` du user-code (option B), l'instanciation des solveurs WASM dans le worker re-déclencherait le même refus CSP. `'wasm-unsafe-eval'` ne suffit pas pour le glue embind dynamique — il faut `'unsafe-eval'`. C'est le point qui enterre B à lui seul : **B ne supprime pas le besoin d'`unsafe-eval` tant que les solveurs WASM tournent dans le worker.**

## 2. Pourquoi « unsafe-eval ciblé (+ sha256 maintenus) » est mal formulé

- Réf config Tauri v2 (https://v2.tauri.app/reference/config/#security / définitions `Csp`, `SecurityConfig`) : la CSP est **globale à l'app** (`app.security.csp`, objet directive → sources). Pas de portée par worker, par route ou par fichier. « Ciblé » ne peut donc signifier qu'une chose : ajout minimal, tout le reste inchangé (pas de `'unsafe-inline'`, `connect-src`/`worker-src` intacts).
- MDN `script-src` (§ Allowlisting external scripts using hashes, Unsafe inline script) : les hashes `sha256-…` ne couvrent que les **blocs inline statiques** (`<script>` présents au parse). Ils ne s'appliquent **pas** aux strings évaluées à runtime (`Function()`/`eval`) — pour celles-ci, `'unsafe-eval'` est tout-ou-rien. Il n'y a donc aucun sha256 à « maintenir » pour ce cas ; la mention du ticket est inapplicable. Le ciblage réel = revue du diff CSP (une ligne) + justification ci-dessus, pas des hashes.

## 3. Pourquoi B (pré-bundling / worker sans `new Function`) est écarté

- `import(blobUrl)` dynamique au lieu de `Function(...)` éviterait l'eval user-code, mais exige `script-src … blob:` (autre élargissement CSP, XSS-pertinent lui aussi) **et** un fork/patch d'`@tscircuit/eval` amont (`evalCompiledJs` + rebuild du worker `entrypoint.js` de 19 Mo) — dépendance externe, maintenance continue à chaque upgrade `0.0.x`.
- Et surtout : B laisse intact le `new Function` Emscripten (§1b). B seul ne fait donc pas passer le build installé. B complet = fork eval **+** rebuild des glue WASM sans embind dynamique : hors de portée, fragile, aucun gain sécurité décisif (`blob:` ≈ `unsafe-eval` face à XSS dans une WebView avec bridge IPC).
- Variante B-lite (transpiler `BOARD_CODE` à la build Vite, `import` statique, zéro eval runtime) : faisable **uniquement** parce que `initialFsMap()` est aujourd'hui une fixture constante — morte dès que l'agent/du user édite du TSX à runtime, ce qui est la direction produit (`docs/research/pipeline-tscircuit-tauri.md` §8 : projets agent-driven). Impasse stratégique, à ne retenir que si le scope reste fixture-only (alors pas besoin de trancher : B-lite ne touche pas la CSP).

## 4. Sécurité : ce que A change et ne change pas

- Changement : une WebView compromise par XSS peut évaluer des strings (surface `eval`/`Function` rouverte). Avec `withGlobalTauri: true`, le bridge IPC reste exposé — le risque XSS→IPC existe déjà aujourd'hui via les scripts bundlés ; `'unsafe-eval'` l'aggrave marginalement (payloads non persistés).
- Inchangé : pas de contenu distant exécutable (`frontendDist` local, `connect-src` restreint à `ipc:`/`http://ipc.localhost` — le CDN est déjà inatteignable en build installé, ce qui explique aussi pourquoi le repli inline ne peut jamais marcher installé), `worker-src` inchangé, pas d'`unsafe-inline`.
- Atténuations recommandées : garder `freezePrototype` / pattern par défaut, ne jamais élargir `connect-src` vers `https:` pour « réparer » l'inline, journaliser le mode de compile (déjà fait : `CompileMode`) pour détecter tout basculement anormal vers `inline-maintenance`/`echec`.

## 5. Critères de preuve sur build installé (pas dev)

Pré-requis : build installé depuis cette machine (`tauri build`), WebView avec console (build `--debug` ou logs `compileBoard` exposés dans l'UI, déjà présents via `log()`).

1. **Cas passant (avec `'unsafe-eval'`)** : machine **hors-ligne** (NIC coupée ou pare-feu bloquant `jscdn.tscircuit.com`, `cjs.tscircuit.com`, `cdn.jsdelivr.net`) → lancer l'app installée → attendre la compile auto : log `worker : N éléments, 0 erreur` avec N > 0, `mode == "worker-blob-local"` (ou `-nocdn` si `disableCdnLoading`), viewers Schéma/PCB/3D non vides, **aucune** entrée console `Refused to evaluate…`, repli `inline` non atteint, zéro requête CDN (vérifiable : `connect-src` les bloquerait de toute façon).
2. **Contrôle négatif (sans `'unsafe-eval'`, CSP actuelle)** : même build, même machine → log `worker blob-url ÉCHEC : Refused to evaluate a string…`, bascule `mode == "echec"` (l'inline échoue aussi : `connect-src` bloque le CDN en installé), bandeau RÉSEAU REQUIS affiché, viewers vides. Reproduit le ticket.
3. **Non-régression** : `tauri dev` + `tsc --noEmit` + `vite build` verts ; diff CSP = une ligne ; aucun sha256 à maintenir (cf. §2).

## 6. Sources (primaires, vérifiées le 2026-11-02)

- Installé : `src/node_modules/@tscircuit/eval/dist/eval/index.js` (`evalCompiledJs` → `Function(...)`), `src/node_modules/@tscircuit/eval/dist/webworker/entrypoint.js` (19 Mo, `transformWithSucrase` + `evalCompiledJs` inlinés, glue Emscripten `new Function` ×2, `craftInvokerFunction`/`emval`, `manifold.wasm`/`krt-wasm`/solvers), `package.json` (`@tscircuit/eval` `0.0.1681`), `src-tauri/tauri.conf.json:19-28` (CSP), `src/src/lib/compile.ts:25-82`, `src/vite.config.ts`, `docs/research/pipeline-tscircuit-tauri.md:15`.
- Amont : https://raw.githubusercontent.com/tscircuit/eval/main/lib/eval/eval-compiled-js.ts (`return Function(functionBody).call(globalThis)`).
- MDN : https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src (§ Unsafe eval expressions : `Function()` bloqué sans `'unsafe-eval'` ; § Unsafe WebAssembly execution : `'wasm-unsafe-eval'` plus spécifique, `'unsafe-eval'` l'emporte ; hashes = inline statique uniquement).
- Tauri v2 : https://v2.tauri.app/reference/config/ (définitions `SecurityConfig`/`Csp` : CSP globale, pas de portée par worker).
