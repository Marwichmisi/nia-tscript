# LLM desktop dans Tauri : clés, confidentialité, offline-first, coûts

> Étude wayfinder:research #50 — « LLM desktop Tauri : clés, confidentialité, offline-first, coûts ».
> Statut : **décision uniquement, ne pas implémenter**. Aucun code joint.
> Date : 2026-11-03. Repo : NiaTScircuit Studio (`dev.nia.tscircuit-studio`, Tauri v2).

## 0. Décision proposée (TL;DR)

**Modèle par défaut : BYOK + Stronghold + Rust-only + aucun appel sans Projet ouvert + confinement réutilisé + allowlist + offline-first.**

1. **BYOK uniquement** : l'utilisateur colle sa propre clé (dialogue natif), stockée
   **chiffrée dans Stronghold** (`vault.hold`, clé dérivée type argon2). Jamais de clé
   embarquée dans le binaire, jamais en clair dans le frontend, le store, ou les logs.
2. **Aucun appel LLM sans Projet ouvert** : réutiliser le confinement existant
   (`NO_PROJECT_OPEN`, `docs/adr/0001-mcp-scope-projet-ouvert.md`). Le périmètre réseau
   suit le périmètre disque.
3. **Appels émis uniquement depuis le backend Rust** (commande `llm_*` dédiée, capability
   explicite). La clé ne traverse jamais la WebView. Le scope du plugin HTTP est en
   allowlist stricte (`https://api.<fournisseur>/v1/*`, `deny` prioritaire) et le
   `connect-src` de la CSP **n'est pas** ouvert aux hôtes LLM (le frontend reste hors-réseau).
4. **Payload minimal + consentement** : seul le `main.tsx` pertinent (et extraits
   `circuit.json` ciblés, jamais le disque entier) part après **opt-in explicite et
   récapitulatif pré-envoi**. Chemins absolutisés relativisés, `previews/`/`exports/`
   exclus, plafond de taille.
5. **Sortie validée, jamais exécutée aveuglément** : tout patch TSX repasse par la compile
   locale (`CircuitRunner` en worker blob-local) avant écriture atomique ; toute écriture
   disque exige validation humaine (HITL).
6. **Offline-first conservé** : `disableCdnLoading` existant + dégradation gracieuse
   (bandeaux, previews figées, sourcing indisponible) ; le LLM est une option, jamais
   une dépendance. Mode local (Ollama `localhost:11434`) possible pour zéro-exfiltration.
7. **Quotas anti-DoW** : `max_tokens` plafonné, budget par session, file bornée, backoff
   sur `429`/`Retry-After`, spend limit côté compte fournisseur.

Les **10 garde-fous non-négociables** sont en §9. Le comparatif BYOK / embarquée / proxy
est en §2.

## 1. Contexte NiaTScircuit (ce qui existe déjà)

- **Confinement mono-projet** : sans Projet ouvert, seuls
  `project_list/current/create/open/close` répondent, tout le reste renvoie
  `NO_PROJECT_OPEN` ; avec Projet, tout est scopé au dossier
  (`main.tsx`, `previews/`, `exports/`)
  ([`docs/adr/0001-mcp-scope-projet-ouvert.md`](../../adr/0001-mcp-scope-projet-ouvert.md)).
  L'alternative multi-projets a été rejetée (risque de fuite inter-projets pour l'agent).
- **Données sensibles par construction** : `main.tsx` = source du design (géométrie,
  choix de composants, netlist logique), `circuit.json` = artefact versionné recréé/migré
  mais jamais inventé (`src-tauri/src/project.rs`, `pcb-mcp/src/project.ts`). Tout envoi
  au modèle expose donc de la PI design — d'où minimisation (§5).
- **Offline strict déjà implémenté** : `disableCdnLoading: true` = worker en blob-local
  bundlé, aucun fetch CDN, bandeau explicite ; previews figées ; recherche JLC/sourcing
  refusée proprement (`pcb-mcp/src/compile.ts`, `preview.ts`, `sourcing.ts`,
  `src/src/lib/compile.ts`). Principe : le réseau est une option dégradable, pas un requis.
- **Surface réseau actuelle verrouillée** : `src-tauri/capabilities/default.json`
  n'autorise que `core:default`, `opener:default`, `dialog:default` et le sidecar
  `pcb-mcp` (`serve --port`, stdin, kill) ; **pas** de plugin `fs`/`http` côté frontend —
  l'accès disque passe par les commandes Rust et le sidecar MCP. La CSP
  (`tauri.conf.json`) limite `connect-src` à `'self' ipc: http://ipc.localhost asset:
  blob: data:`. Tout ajout LLM doit préserver ce niveau.

## 2. BYOK vs clé embarquée vs proxy serveur

| Critère | **BYOK (recommandé, défaut)** | Clé embarquée (rejetée) | Proxy serveur (option phase 2) |
|---|---|---|---|
| Secret côté client | Clé de l'utilisateur, chiffrée (Stronghold) | Clé éditeur dans le binaire = extractible (`strings`), non révoquable par utilisateur | Aucune clé sur le poste |
| Facturation / abus | L'utilisateur paie son usage ; quotas de son projet | **Denial-of-Wallet** mutualisé : un abus vide le compte éditeur ([OWASP LLM10](https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM10_UnboundedConsumption.md)) | Mutualisée côté serveur, contrôlable (quotas/rabais) |
| Révocation / rotation | Rotation par l'utilisateur ; clés à expiration + suivi d'usage ([guide prod OpenAI](https://developers.openai.com/api/docs/guides/production-best-practices.md) : expiration, rotation, projets staging, alertes de dépense) | Rotation = republication du binaire ; fuite = incident | Rotation centralisée |
| Confidentialité | Contrat direct utilisateur↔fournisseur ; l'éditeur ne voit rien | L'éditeur reste responsable du tuyau | Les designs transitent par le serveur éditeur → contrat de non-rétention + audit requis |
| Offline / coût ops | Aucune infra éditeur | Aucune, mais risque financier | Serveur à opérer, latence +, point de confiance + |
| Conformité OpenAI | Conforme : « ne pas exposer les clés dans le code ni les dépôts ; variables d'environnement ou secret manager » ([guide prod](https://developers.openai.com/api/docs/guides/production-best-practices.md)) | **Contraire** à cette règle | Conforme si secret côté serveur |

**Conclusion** : défaut = **BYOK**. Proxy = option ultérieure si besoin de quotas
centralisés ou de modèles privés, jamais avec les designs en clair sans engagement
écrit de non-rétention. Clé embarquée = **interdite** (G1).

## 3. Stockage du secret : Stronghold, pas le store

- **Plugin `store`** : simple key-value persistant (fichier dans l'app-data), dont le
  [README](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/store/README.md)
  ([page](https://v2.tauri.app/plugin/store/)) **ne documente aucun chiffrement**.
  Usage : préférences, état UI, budgets — **jamais la clé API** (G2).
- **Plugin `stronghold`** : « Store secrets and keys using the
  [IOTA Stronghold](https://github.com/iotaledger/stronghold.rs) secret management
  engine » ([README](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/stronghold/README.md),
  [page](https://v2.tauri.app/plugin/stronghold/)). Snapshot chiffré (`vault.hold`),
  clé de vault dérivée d'un mot de passe (exemple argon2 fourni dans le README).
  → **seul stockage admissible pour la clé BYOK** : saisie via dialogue natif
  (`dialog:default` déjà en capability), dérivation côté Rust, jamais de copie vers
  la WebView/`localStorage`.
- Règle OpenAI applicable : exposer la clé à l'app via variable d'environnement ou
  secret manager, jamais hard-codée ; expiration + rotation régulières ; révocation
  immédiate si compromise
  ([guide prod](https://developers.openai.com/api/docs/guides/production-best-practices.md),
  [safety best practices — revoke](https://developers.openai.com/api/docs/guides/safety-best-practices.md)).
  En desktop, l'équivalent « secret manager » = **Stronghold**, pas une `.env` livrée.

## 4. Périmètre réseau (allowlist)

- **Capabilities Tauri v2** : système d'autorisations granulaires par fenêtre/webview,
  permissions `allow-*`/`deny-*` fusionnées ([doc](https://v2.tauri.app/security/capabilities/)).
  Principe : moindre privilège, tout ce qui n'est pas autorisé est refusé.
- **Plugin HTTP** : `http:default` active les opérations fetch **sans autoriser aucune
  origine** — les origines doivent être configurées explicitement
  ([référence des permissions](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/permissions/autogenerated/reference.md),
  [README](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/http/README.md),
  [page](https://v2.tauri.app/plugin/http-client/)).
  Le scope Rust `allow`/`deny` par motifs d'URL fait foi, **`deny` prioritaire**
  ([`scope.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/src/scope.rs)).
  → allowlist proposée : `https://api.openai.com/v1/*` (ou hôte du fournisseur choisi)
  et, en mode local, `http://localhost:11434/*` uniquement ; `deny: ["*://*"]` en garde.
- **CSP** : la CSP Tauri réduit l'impact XSS ; les scripts distants/CDN sont à éviter et
  `connect-src` doit rester minimal ([doc CSP](https://v2.tauri.app/security/csp/)).
  → **ne pas** ajouter l'hôte LLM au `connect-src` de la WebView : le frontend ne doit
  pas appeler le LLM en direct (clé + prompts fuiraient via DevTools/XSS). Seule une
  commande Rust `llm_*` exposée en capability y a droit.
- **FS** : le modèle existant (commandes Rust scopées au dossier Projet, pas de plugin
  `fs` large) suit la même logique que les scopes `fs:scope` allow/deny du plugin
  ([référence](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/fs/permissions/autogenerated/reference.md)).
  Le LLM ne doit jamais obtenir d'accès disque hors dossier Projet (G3, §9).

## 5. Confidentialité : ce qui part au modèle, quoi masquer

Tout prompt contenant `main.tsx`/`circuit.json` expose : topologie du circuit, choix et
valeurs de composants, empreintes, annotations — soit la PI de l'utilisateur. Règles,
alignées sur [OWASP LLM02](https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM02_SensitiveInformationDisclosure.md)
(sanitization, moindre privilège, transparence d'usage, opt-out d'entraînement,
redaction/tokenization) :

1. **Minimisation** : n'envoyer que le fragment utile (fonction/composant ciblé ou
   diff), jamais le disque entier ; exclure `previews/`, `exports/`, binaires.
2. **Relativisation** : convertir les chemins absolus (`/home/<user>/…`) en chemins
   relatifs au Projet avant envoi ; retirer identifiants machine, tokens, URLs privées.
3. **Plafond** : taille max du payload (ex. quelques dizaines de Ko) + refus explicite
   au-delà, comme `disableCdnLoading` refuse le réseau (cohérence UX existante).
4. **Consentement** : opt-in explicite (toggle persistant) **+** récapitulatif pré-envoi
   (« ce prompt contient main.tsx (≈ N lignes) et 12 éléments circuit.json ») avec
   bouton Annuler ; aucun envoi en arrière-plan.
5. **Contrat fournisseur** : exiger l'option de non-entraînement / non-rétention du
   fournisseur choisi et l'afficher dans l'UI. Sans engagement écrit : mode local uniquement.
6. **Toxicité des contenus tiers** : snippets de registre, résultats JLC, docs importées
   = entrée **non fiable** → injectables ([OWASP LLM01](https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM01_PromptInjection.md),
   injections indirectes). Les baliser comme données, jamais comme instructions ; ne
   jamais exécuter une instruction venue du modèle sans validation (§6).

## 6. Sorties du modèle : valider avant d'écrire (HITL)

- [OWASP LLM01](https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM01_PromptInjection.md) :
  contraindre le comportement (rôle, format de sortie strict type patch), filtrer
  entrée/sortie, moindre privilège, **approbation humaine des actions à risque**,
  tests adversariaux.
- [OWASP LLM06 — Excessive Agency](https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM06_ExcessiveAgency.md) :
  minimiser extensions/fonctionnalités/permissions, **pas d'extension ouverte**
  (« exécuter un shell », « fetch une URL »), agir dans le contexte de l'utilisateur,
  médiation complète côté système (le LLM ne décide pas des autorisations), log +
  rate-limit en filets.
- OpenAI [safety best practices](https://developers.openai.com/api/docs/guides/safety-best-practices.md) :
  **human-in-the-loop** (relecture avant usage, critique pour le code), tests
  adversariaux (« ignore les instructions précédentes… »), contraindre entrées et
  `max_tokens`, canal de signalement.
- Traduction NiaTScircuit : sortie LLM = **patch TSX proposé** → relecture humaine →
  compile locale obligatoire → écriture atomique existante (`write_project_main`) →
  resync disque. Aucune commande destructive (suppression, export, flash) déclenchée
  par le modèle sans clic explicite.

## 7. Mode Sans GPU / offline strict (`disableCdnLoading`) et dégradation

- Le pipeline actuel tourne déjà en **worker blob-local** sans CDN.
  Le LLM ne doit pas casser cette propriété : **aucun appel réseau bloquant le rendu**.
- Matrice de dégradation proposée :

| Mode | Réseau | LLM | Comportement |
|---|---|---|---|
| En ligne + BYOK | autorisé (allowlist) | cloud | assistance complète, quotas actifs |
| En ligne sans clé | autorisé | aucun | app 100 % fonctionnelle, panneau LLM désactivé avec explication |
| **Offline strict** (`disableCdnLoading`) | coupé | aucun ou local | compile locale, previews figées, sourcing refusé (bandeaux existants) |
| **Sans GPU / CPU seul** | indifférent | local quantifié ou aucun | modèles locaux lents → tâches courtes uniquement, **pas d'agent autonome** ; repli cloud sur opt-in |
- Local : Ollama expose une API REST sur `http://localhost:11434/api/chat`
  ([README Ollama](https://github.com/ollama/ollama), [API](https://docs.ollama.com/api),
  backend [llama.cpp](https://github.com/ggml-org/llama.cpp)) → allowlist locale triviale,
  **zéro exfiltration**.

## 8. Coûts, latence, quotas

- **Modèle économique** : paiement à l'usage, prix par tranches de tokens
  ([guide prod OpenAI](https://developers.openai.com/api/docs/guides/production-best-practices.md)).
  Prévoir l'équivalent par fournisseur dans le comparatif d'implémentation.
- **Garde-fous quantitatifs** : paliers d'usage et limites mensuelles, alertes de dépense,
  **hard spend limit**, rate limits RPM/TPM/RPD/TPD avec en-têtes `x-ratelimit-*` et `Retry-After`
  ([rate limits](https://developers.openai.com/api/docs/guides/rate-limits.md)).
  Côté app : budget tokens/session, file d'appels bornée, backoff exponentiel + jitter,
  pas de retry sur erreurs de quota/facturation.
- **Latence** : dominée par la génération token-par-token ; leviers = modèle plus petit,
  `max_tokens` bas, stop sequences, streaming. Pour l'UX : streamer dans un panneau non bloquant, annulable.
- **[OWASP LLM10](https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM10_UnboundedConsumption.md)** :
  validation des tailles d'entrée, rate limiting + quotas, timeouts/throttle,
  sandbox réseau du LLM, **dégradation gracieuse**, file d'actions bornée.

## 9. Garde-fous non-négociables (G1–G10)

- **G1 — Pas de clé embarquée.** Aucun secret dans le binaire, le frontend, le dépôt. BYOK ou proxy serveur.
- **G2 — Stronghold seul pour la clé.** Chiffré au repos ; jamais dans `store`, `localStorage`, logs.
- **G3 — Pas de Projet ouvert = pas d'appel.** Réutiliser `NO_PROJECT_OPEN`.
- **G4 — Allowlist réseau double.** Scope plugin HTTP + CSP non élargie ; backend Rust seul.
- **G5 — Minimisation + consentement.** Payload minimal, chemins relativisés, plafond de taille, récapitulatif pré-envoi, opt-in explicite.
- **G6 — HITL sur toute écriture.** Patch relu + compilé localement avant écriture atomique.
- **G7 — Quotas et coupe-circuit.** `max_tokens`, budget session, file bornée, backoff `429`/`Retry-After`, hard limit.
- **G8 — Logs sans secrets, télémétrie opt-in.** Zéro clé, zéro prompt intégral, zéro PII.
- **G9 — Offline total fonctionnel.** L'app compile/prévisualise/exporte sans réseau ni LLM.
- **G10 — Contenus tiers = données.** Jamais promus en instructions ; validation stricte des sorties.

## 10. Checks d'acceptation du ticket

- [ ] Choix distribution tranché : **BYOK** (proxy en option phase 2, embarquée refusée).
- [ ] Stockage : **Stronghold chiffré**, store exclu pour les secrets.
- [ ] Réseau : scope HTTP allowlist + CSP non élargie + commande Rust unique.
- [ ] Confidentialité : minimisation + masquage + consentement pré-envoi.
- [ ] Offline : matrice §7 respectée, `disableCdnLoading` intact.
- [ ] Coûts : budgets + hard limits + backoff spécifiés avant tout appel payant.
- [ ] Logs/télémétrie : sans secrets, opt-in uniquement.
- [ ] OWASP : LLM01/02/06/10 couverts par G1–G10.

## 11. Sources primaires

**Tauri v2**
- Capabilities : <https://v2.tauri.app/security/capabilities/>
- CSP : <https://v2.tauri.app/security/csp/>
- Plugin store : <https://v2.tauri.app/plugin/store/>
- Plugin stronghold : <https://v2.tauri.app/plugin/stronghold/>
- Plugin HTTP : <https://v2.tauri.app/plugin/http-client/>
- Plugin log : <https://v2.tauri.app/plugin/logging/>

**Fournisseurs LLM**
- OpenAI production best practices : <https://developers.openai.com/api/docs/guides/production-best-practices>
- OpenAI safety best practices : <https://developers.openai.com/api/docs/guides/safety-best-practices>
- OpenAI rate limits : <https://developers.openai.com/api/docs/guides/rate-limits>
- Ollama : <https://github.com/ollama/ollama> · API : <https://docs.ollama.com/api>

**OWASP LLM Top 10 2025**
- LLM01, LLM02, LLM06, LLM10 (repo GitHub `2_0_vulns`) ; synthèse <https://genai.owasp.org/llm-top-10/>

**Repo local**
- `docs/adr/0001-mcp-scope-projet-ouvert.md`, `docs/research/pipeline-tscircuit-tauri.md`, `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json`
