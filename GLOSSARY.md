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
