# Audit AFK ticket #51 — insuffisances création carte (MCP + app)

Contraintes respectées : projets jetables `/tmp` uniquement, lecture seule du repo, aucun fix/commit/push.

## 1. Liste ordonnée des insuffisances reproduites

### I1. Placement rouge dès qu'on bouge/ajoute — gate DRC bloque route + fab
- Commande : `tools/call live_manage {op:"move", refdes:"R1", x:50, y:50}` sur `carte-demo` jetable (demo pure verte au départ).
- Réponse : `applied=true, ready=false, errors=12, diag0="<trace#295…/> is missing a name…"`.
- Puis `run_checks {domain:"all"}` : `placementGreen=false, total=3, premier="SMT pad R1.pin1 violates copper-to-board-edge clearance (measured 0.000mm, required 0.200mm)"`.
- Puis `fab_export {}` : `ready=false, msg="DRC rouge : placement non vert…"`.
- Attendu : guide préventif (hors-board) avant d'appliquer. Obtenu : appliqué puis tout l'aval refuse.
- Classement : **MCP** (gate dur) + **app** (mêmes checks natifs) ; demo pure verte, modifiée rouge.

### I2. Route : on ne sait pas quand router, `isBoardRouted` imprévisible
- `withLocalAutorouter(code,"1x")` → `ok=true` ; `compileTsx` → `errors=12, routed=false` (demo+C1 modifiée) ; `route` sur `routingDisabled` → refus explicite.
- MCP `batch_execute [{kind:"route"}]` sur placement rouge : `applied=false, rolledBack=true, errors=12` — la cause gate est masquée par les diagnostics compile.
- Paradoxe : demo pure fabrique sans op `route` (`ready=true, gerbers=10, bom=3, pnp=3`), donc l'agent ne sait pas si `route` est requise.
- Classement : **MCP**.

### I3. `live_manage` applique même en compile erreur — mémoire diverge du disque
- `applied=true` avec `errors=12` ; `setCode(mutated)` sans `persistCurrent` → disque inchangé, mémoire à jour, `ready=false`.
- Attendu : `applied=false` ou avertissement divergence.
- Classement : **MCP**.

### I4. Ancres/refdes exacts exigés, erreurs exploitables mais sans suggestion
- Ancre 0 occurrence → introuvable ; `footprint=` → ambiguë (4 occurrences) ; `live move R99` → introuvable ; `reassign` pin-pin → réécrire via `code_patch` ; `create/delete` → refusés vers `code_patch`.
- Attendu : proposition (plus proche refdes, extrait). Obtenu : message seul.
- Classement : **MCP** (spec V1 assumée).

### I5. Sourcing JLC caractérisé
- `query vide` / `disableCdnLoading` → refus sans fetch ; `429/503/404/JSON/timeout/fetch failed` → tous gérés avec messages exploitables (stubs).
- `RP2040` 0 résultats + guidance ; ranking nécessaire (sans rank `0805` avant `0402`) ; stock `null` best-effort ; `mouser` refusé V2.
- Réseau réel `10k` : `ok=true, n=3` en **13624 ms** — aucun timeout côté sidecar, outil bloqué.
- Classement : **fonctionnement** + **MCP**.

### I6. Preview/screenshot vérifié en profondeur
- Direct : roundtrip 1x1 `bytes=70 file://` ; dims appelant priment sur IHDR ; slug `Ma Capture!! 2026`→`Ma-Capture-2026`, `latest` nommé, `long>50→32` ; jpeg/base64/pdf refusés ; `>20 Mo` refusé sans écrire ; LRU 51e → `evicted=1, total=50`.
- Offline : présent → `found=true + banner RÉSEAU REQUIS` ; absent → `found=false + banner + consigne Screenshot`.
- MCP : absent `found=false errors=1` ; après dépôt PNG → `found=true bytes=70 file://` ; alias+nommé ok ; hors-registre `OUT_OF_SCOPE` ; après close `NO_PROJECT_OPEN`.
- App : bouton désactivé si `compiling || circuitJson vide` ; canvas>1000 sinon SVG→canvas sinon throw ; `save_screenshot` → `<projet>/previews/` sinon cache global, hors-Tauri `previewUrl=null`.
- Friction : headless `found=false` bloquant sans WebView (jamais inventé — correct mais bloquant).
- Classement : **fonctionnement** + **MCP** + **app**.

### I7. `fab_export` board vide `ready=true` — aucun garde
- `project_create vide` → `fab_export` : `ready=true, gerbers=9, bomRows=0, pnpRows=0`, `run_checks` vert `total=0`.
- Attendu : avertissement/refus « board vide ».
- Classement : **MCP**.

### I8. `exportFab` pur vs outil MCP divergent
- Pur : `[]` → refus (bien) mais `resistor` sans props (compile erreur) → `ok=true`.
- Outil MCP : mêmes cas refusés via gates.
- Classement : **MCP**.

### I9. Extracteurs diagnostics front vs sidecar divergent
- Sidecar `/(^|_)error$/` vs front `includes("error")` : `error_report` compté erreur côté app, ignoré côté MCP → comptes/gates incohérents.
- Classement : **MCP vs app**.

### I10. Hiérarchie `pcb://hierarchy` statique + leak nom board
- Toujours `R1/0402 + C1/0603` même si TSX = `R1/R2/U1` ; sans isolation, `board` lu depuis le vrai lockfile.
- Classement : **MCP**.

### I11. Confinement : deux codes, lecture refusée hors périmètre
- Sans projet → `NO_PROJECT_OPEN` ; hors-registre → `OUT_OF_SCOPE` (dont preview en lecture).
- Friction : l'agent doit brancher deux codes.
- Classement : **MCP** (voulu, à documenter).

### I12. Batch atomique ok mais diagnostic route masque le gate
- `batch [move valide + move R99]` → `applied=false, rolledBack=true, failedOp=1`, code inchangé vérifié — bien.
- `batch [route]` sur rouge → diagnostics compile au lieu de `routing refusé : <blockReason>` — cause masquée.
- Classement : **MCP**.

### I13. Parité App/MCP (statique, GUI non exécutée)
- Mêmes règles layout/Registre/lockfile/watcher ; divergences : repli inline CDN front seul, diagnostic I9, screenshot I6, suppression à jeton + `forget` non testés.
- Classement : **app vs MCP**.

## 2. Fix v0.1.x vs spec agent

**Fix v0.1.x :** I9 (unifier sur la regex stricte sidecar), I10 (hiérarchie dynamique + `board` isolé), I7 (refuser/avertir `fab_export` si 0 composants), I8 (mêmes gates dans `exportFab` pur ou marquage interne), I12 (prioriser `blockReason` gate), timeout + progression `search_parts`, I6 rien en code (quotas/normalisation déjà bons).
**Spec agent :** I1 (placer au centre + vérifier bords, lire `missingCoords`), I2 (router si `boardExpectsRouting && !isBoardRouted` + `routingAllowed`), I3 (vérifier `ready/errors` + relire disque), I4 (ancre exacte + `select/view` d'abord), I5 (requêtes `valeur+package`, réf LCSC, `tsci` en secours, DigiKey/Mouser=V2), I6 (workflow ouvrir app → onglet → Screenshot, alias, slug 32, codes), I11 (deux codes), I13 (matrice parité).
