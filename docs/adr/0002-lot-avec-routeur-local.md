# 0002 — Lot avec routeur local (extension de 0001)

Date : 2026-11-03. Contexte : `0001-mcp-scope-projet-ouvert.md` fige
`batch_execute` en patch+live ; le ticket #44 y a ajouté `route`.
Autorité : spec #37 (Implementation Decisions → Routeur), supérieure à
l'ADR — l'ajout est une extension actée, pas une dérive.

## Décision

`batch_execute` accepte une op `route` : épingle l'autorouteur local
`auto_local` (offline-first, aucun appel réseau, coût nul, atomicité
préservée) avec effort configurable `autorouterEffortLevel`, puis exige —
avant de rendre la main — le gate placement vert, la preuve de routage
effectif (`pcb_trace` avec `route` non vide) et zéro violation DRC, sinon
rollback complet comme toute op du Lot.

## Conséquences

- Le routeur externe/cloud est écarté (offline-first, coût, atomicité).
- `fab_export` refuse un board `routingDisabled` ou non routé et exige le
  DRC vert : aucun gerber sans cuivre.
- `0001` reste valide pour le reste (scope Projet ouvert, patch+live avec
  autosave) ; la présente ADR fait foi pour l'op `route`.
