# 0003 — Écrivains du Registre : backend + sidecar (déviation actée)

Date : 2026-11-03. Contexte : spec #37 « un seul écrivain (le backend) »,
revue #37 item 7. Décision mère : `0001-mcp-scope-projet-ouvert.md`.

## Déviation actée

Le sidecar écrit lui aussi le Registre et le lockfile
(`project_create/open/close` → `saveRegistry` + `writeLockProjectPath`).
Le runtime n'est PAS changé (risque) : le sidecar est déployable seul
(bridge stdio) et aucun canal sidecar→backend n'existe pour déléguer
l'écriture.

## Pourquoi c'est sûr

- Atomicité des deux côtés : sidecar `atomicWriteFileSync`
  (tmp+rename+fsync, `pcb-mcp/src/project.ts`), backend `boot::atomic_write`
  (`src-tauri/src/boot.rs`). Un kill en pleine écriture ne tronque jamais.
- Clés canoniques partagées : `canonicalProjectPath` (Node) et
  `canonical_project_path` (Rust) appliquent la même règle (absolu, sans
  slash final, symlinks résolus) via `upsertRegistry` des deux côtés.
- Chemins sidecar vérifiés (revue #37) : tout write Registre/lockfile passe
  par `saveRegistry`/`writeLockProjectPath`, toute persistance Projet par
  `persistProjectFiles`/`ensureProjectLayout` — aucun `writeFileSync`
  direct (garde statique : `registry-atomic.test.ts`, écrivains directs
  limités à logs/captures/exports).
- Réconciliation backend au boot : existence vérifiée, Projet orphelin
  explicite, `current` réinitialisé si introuvable (jamais de fixture
  silencieuse). Dernier écrivain gagne, sans entrée perdue à moitié
  (fichiers toujours complets grâce à l'atomicité).

## Conséquence

Deux écrivains atomiques au lieu d'un. Retour au mono-écrivain exigerait
un canal sidecar→backend (hors spec V1) ; en attendant, cette ADR fait foi.
