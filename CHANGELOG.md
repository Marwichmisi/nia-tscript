# Changelog

Tout changement notable est documenté ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

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
