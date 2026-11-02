# MCP scopé au Projet ouvert

Sans Projet ouvert, seuls `project_list/current/create/open/close` répondent, tout le reste renvoie `NO_PROJECT_OPEN`. Avec Projet, tout est scopé au dossier (`main.tsx`, `previews/`, `exports/`), `fab_export.project_name` déprécié au profit du basename, `batch_execute` reste patch+live avec autosave.

Alternative rejetée : multi-projets simultanés — complexité file/compile et fuite inter-projets pour l'agent.
