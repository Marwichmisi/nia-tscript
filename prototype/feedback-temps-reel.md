# Prototype jetable — feedback temps réel (ticket #35)

> Artefact brut pour réagir, pas du code à merger. Appuie sur les décisions #29 (event
> `project-main-changed`), #33 (disque source, orphelin explicite) et #34 (Confinement).

## 1. Bandeau d'état (remplace le texte `prêt — url (pid)` / `démarrage…` nu)

```
[● vert] Prêt — Projet ouvert : capteurs-temp (/home/m/niats/capteurs-temp)   │ MCP : connecté (port 36515)
[◌ambar] Compilation… (relecture disque → worker)                            │ MCP : écriture reçue, resync…
[● rouge] Erreur lecture main.tsx : <message> — [Réessayer]                   │ MCP : connecté
[◆ gris]  Accueil — aucun Projet ouvert                                       │ MCP : en attente d'ouverture
```

- `aria-busy="true"` sur les viewers pendant `Compilation…`.
- Plus de `window.confirm` : les erreurs passent par ce bandeau + toast.

## 2. Bouton Recompiler (remplace `setNonce(n+1)` aveugle)

1. `disabled` pendant `compilation…` (fini le double-clic en boucle).
2. Au clic : `read_project_main` d'abord, compare hash → si identique, toast
   « Déjà à jour (hash ab12…) », pas de recompile ; sinon compile le code relu.
3. Label dynamique : `Recompiler` → `Relecture + compilation…` → `Recompiler`.

## 3. Toasts (nouveau, coin bas-droit, `role="status"`)

- `MCP : main.tsx mis à jour par l'agent — resync ✓ (hash ab12 → cd34)`
- `Échec resync : <message> — [Réessayer] [Voir les logs]`
- `Capture enregistrée : previews/shot__vue-pcb.png`
- Durée 6 s, empilés max 3, jamais de `console.error` silencieux (cf. Home).

## 4. Logs Terminal (`ol`, remplace le flux muet)

- `aria-live="polite"` sur les lignes info, `role="alert"` sur les erreurs compile/DRC.
- Chaque ligne d'écriture MCP : `[12:01:44] mcp : code_patch appliqué (hash cd34, 3 erreurs embarquées → voir DRC)`.
- Les `\n` issus du TSX sont échappés (une ligne = un `<li>`, anti log-forgery).

## 5. Viewers (remplace fallback collé + `viewer-empty` nu)

- `ErrorBoundary` reset sur `circuitJson`/`nonce`, plus seulement sur `tabName`.
- Projet vide (board 20×20, 0 composant) : état explicite
  `Projet vide — board 20×20 mm, 0 composant. [Ouvrir le Gabarit démo] [Coller du TSX]`
  au lieu de `Pas de circuit-json — ouvre la Console`.
- Screenshot `disabled` pendant `compiling` (fini la capture obsolète), toast après capture.

## 6. Accueil (homonymes #33 + pont #34)

```
Projets :
  ● capteurs-temp — /home/m/niats/capteurs-temp        [Ouvrir]
  ● board — /home/m/niats/client-a/board               [Ouvrir]
  ◇ board — /home/m/niats/client-b/board               [Ouvrir]   ← homonyme, parent affiché
  ⚠ vieux-proto — dossier introuvable (Projet orphelin) [Relink] [Oublier]
```

- Bouton `Copier la commande` `disabled` + tooltip tant que `bridge_path` vide
  (fini le faux négatif `Pont introuvable` pendant le boot).

## Question pour réagir

Qu'est-ce qui te gêne dans ce découpage : trop de toasts (préférer tout dans le bandeau ?),
le `disabled` strict du Recompiler (garder un forçage manuel ?), ou le wording FR des états ?
