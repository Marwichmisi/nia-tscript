# NiaTScircuit

Application Tauri de création de carte PCB pilotée par agent IA via MCP.

## Language

**Projet**:
Un dossier filesystem choisi par l'utilisateur qui contient tout le travail.
_Avoid_: workspace, session, board, dossier de travail

**Projet ouvert**:
L'unique Projet chargé dans l'application et seul exposé au MCP.
_Avoid_: projet sélectionné, projet courant, session active

**Accueil**:
La page de démarrage listant les Projets connus et permettant d'en créer un.
_Avoid_: home, dashboard, preview

**Registre**:
La liste persistée des Projets connus et du dernier Projet ouvert.
_Avoid_: historique, récents, config projets

**Gabarit démo**:
Le circuit d'exemple R1/R2+U1 proposé comme contenu initial optionnel.
_Avoid_: demo board, nia-demo, fixture

**Projet orphelin**:
Un Projet du Registre dont le dossier est introuvable sur disque.
_Avoid_: projet manquant, projet invalide

**Lot**:
Une liste atomique d'opérations patch+live appliquée en une seule compile avec rollback.
_Avoid_: batch, transaction, lot atomique

**Sans GPU**:
L'absence de `navigator.gpu` utilisable, incluant WebKitGTK Linux sans WebGPU même avec GPU physique.
_Avoid_: pas de carte graphique, PC faible, sans accélération

**Rendu PCB**:
L'onglet PCB 2D affichant pastilles et traces depuis le circuit-json.
_Avoid_: viewer PCB, PCB viewer, aperçu PCB

**Review 3D**:
L'onglet 3D `CadViewer` affichant le volume carte + composants via three.js.
_Avoid_: vue 3D, 3D viewer, preview 3D

**Manifold**:
Le module WASM de géométrie booléenne chargé par la Review 3D pour construire le board.
_Avoid_: manifold-3d, moteur 3D, WASM 3D

**Capture nommée**:
Un screenshot agent stocké sous `<source>__<slug>.png` dans `<Projet ouvert>/previews/`, relu via `source + name?`.
_Avoid_: screenshot custom, image labellisée, snapshot nommé

**Confinement**:
La règle backend qui n'autorise les opérations dossier que sur un Projet du Registre, après `canonicalize`.
_Avoid_: jail, sandbox, bac à sable

**Agent intégré**:
Le chat IA directement dans l'application, second consommateur des mêmes outils que le pilotage MCP externe.
_Avoid_: chatbot, assistant externe, pilote MCP

**Conversation**:
L'historique des échanges avec l'Agent intégré, rattaché à un Projet ouvert, avec compaction au seuil et possibilité de repartir à neuf.
_Avoid_: session, thread, chat global

**Mode d'approbation**:
Le réglage qui décide quand l'Agent intégré doit demander avant de modifier : Manuel (1 approval par Lot) ou Auto modifications (suppression du Projet toujours manuelle).
_Avoid_: auto-approve, autopilote, validation auto
