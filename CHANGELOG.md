# Changelog

Tout changement notable est documenté ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

## [0.1.3] - 2026-11-03

Stabilisation du Studio piloté par MCP : l'application suit désormais l'agent en temps réel, le Registre est atomique, les opérations dossier sont confinées et la compilation est alignée des deux côtés.

### Ajouté
- Resync temps réel : chaque écriture MCP sur le Projet ouvert pousse un événement `{ path, hash }` (watcher backend avec debounce) et la WebView resynchronise depuis le disque, avec toast et bandeau d'état (prêt / compilation / erreur + Réessayer).
- Bouton Recompiler avec relecture disque d'abord (toast « Déjà à jour » si identique), désactivé pendant la compilation.
- Routeur local dans le Lot atomique : op `route` (effort 1x–100x, `autorouter="auto_local"`), gate DRC avant export, rollback conservé.
- Sourcing JLC/LCSC étendu : erreurs réseau distinguées (500/429/timeout/JSON invalide) avec messages exploitables par l'agent, validation d'empreinte locale obligatoire, refus offline-first avant tout fetch.
- Feedback UX temps réel : toasts `role=status` (max 3), logs `aria-live` poli avec erreurs en alerte, Projet vide explicite (charger le gabarit démo / coller du TSX), Accueil avec parents des homonymes et orphelins signalés (Relink/Oublier), Copier-commande désactivé pendant le boot, captures désactivées pendant la compilation.
- Confinement : suppression d'un Projet derrière une confirmation backend à jeton unique (dialogue dédié, l'oubli ne touche jamais au disque) ; boot durci (lockfile 0600, refus sidecar stub/world-writable) ; quotas captures (20 Mo max, 50 fichiers LRU + compteur).
- `circuit.json` versionné (recréé si absent, corrompu = erreur visible, jamais de fixture silencieuse) ; `write_project_main` atomique côté backend.
- Reproductibilité : versions `bun`/`node`/`rust` épinglées, gates CI (`bun test` + `cargo test` + types first-party bloquants), sidecar vérifié (taille + permissions), lockfile régénéré.
- Diagnostics de compilation exploitables : erreurs embarquées du circuit-json remontées (fini le « 0 erreur »), gate de placement conservé, `domain=all` sans routage quand interdit, `fab_export` bloqué si DRC rouge.
- ADR `0002-lot-avec-routeur-local`, `0003-ecrivains-registre`, terme `Confinement` au glossaire.

### Corrigé
- L'éditeur restait figé sur les écritures de l'agent ; Recompiler rejouait un snapshot périmé.
- Entrées de Registre perdues en écritures concurrentes ; suppression possible hors périmètre ; binaire sidecar world-writable accepté.
- Faux positifs de diagnostics (sous-chaînes `error`/`warning`) et détection de routage trompée par les commentaires TSX.
- Pinning partiel des moteurs tscircuit (dérive des satellites) ; types first-party non vérifiés en CI.

## [0.1.2] - 2026-11-02

### Ajouté
- Page d'Accueil par défaut : tuile géante « Créer mon premier projet » à vide, liste des projets + petite action quand des projets existent (DA zinc existante).
- Notion Projet = dossier (`main.tsx`, `circuit.json`, `previews/`, `exports/`) avec gabarits `vide` (défaut) et `gabarit démo`.
- Registre persistant partagé Rust ↔ sidecar (`niatscircuit/projects.json`), trié par `lastOpened`, badge `introuvable` pour les Projets orphelins.
- 8 commandes Tauri : `list/create/open/close/current/forget/delete_project`, `read_project_main`.
- 5 outils MCP projet : `project_list/current/create/open/close` ; sans Projet ouvert, tout le reste renvoie `NO_PROJECT_OPEN`.
- Gating strict mono-projet : tous les outils scopés au dossier ouvert, `previews/` et `exports/` migrés dedans, `fab_export.project_name` déprécié (basename).
- `batch_execute` reste patch+live avec autosave `main.tsx` + `circuit.json`.
- Sélecteur de dossier natif (`@tauri-apps/plugin-dialog`).
- ADR `0001-mcp-scope-projet-ouvert`, glossaire (`Projet`, `Accueil`, `Registre`, `Lot`…).

### Corrigé
- Dépendance `@tscircuit/solver-utils` manquante qui cassait `vite build` prod.

## [0.1.1] - 2026-11-02

- Première release : fix CSP (`unsafe-eval`), `ENTRYPOINT` + pont MCP embarqué, compile offline-first partagée.
