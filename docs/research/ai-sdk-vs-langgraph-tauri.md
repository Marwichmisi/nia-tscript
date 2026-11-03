# Chat agent Tauri + tool-calling : AI SDK vs LangGraph — choix stack (ticket #49)

- Statut : étude décisionnelle, **ne pas implémenter** (le lead décide puis ouvre les tickets d'implémentation).
- Contexte : chat agent **dans l'app Tauri** (frontend React + backend Rust + TS existant), outillage existant : `compileTsx` (`pcb-mcp/src/compile.ts`), `batch_execute` atomique « une approbation = un lot » (`docs/mcp-approvals.md`, `pcb-mcp/src/mcp.ts`), `preview_screenshot` lecture seule (`pcb-mcp/src/preview.ts`), sourcing JLCPCB-first avec refus offline explicite (`pcb-mcp/src/sourcing.ts`).
- Méthode : sources primaires uniquement (docs officielles Vercel AI SDK, Anthropic, OpenAI, LangChain/LangSmith, Tauri). Chaque affirmation renvoie à sa source.

## TL;DR — décision recommandée

- **Stack par défaut : Vercel AI SDK** (`ai` + `@ai-sdk/react` + providers `@ai-sdk/anthropic` / `@ai-sdk/openai`) + couche d'approvals maison au niveau `batch_execute` + persistance historique via Tauri (Store/SQLite).
  - Pourquoi : TS-first ([introduction AI SDK](https://ai-sdk.dev/docs/introduction)), tool-calling standardisé multi-providers avec schéma Zod validé côté SDK ([tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)), structured output combinable aux tools ([generating structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)), boucle agent `stopWhen: isStepCount(n)` et classe `ToolLoopAgent` recommandée ([agents overview](https://ai-sdk.dev/docs/agents/overview)), streaming + `useChat` à architecture transport ([useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)), tests unitaires sans réseau via `MockLanguageModelV4` ([testing](https://ai-sdk.dev/docs/ai-sdk-core/testing)), observabilité OpenTelemetry standard ([telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)), MCP natif côté client ([mcp-tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)) qui mappe directement sur le sidecar MCP existant.
- **Alternative : LangGraph.js** (`@langchain/langgraph`) si le besoin devient un graphe long avec checkpoints persistants, reprise/time-travel et approvals par nœud — au prix d'un runtime plus lourd et d'une infra de persistance (cf. § Réversibilité).
- **Écartés** : SDK direct Anthropic/OpenAI seul (contrôle max, zéro dépendance, mais réinvente boucle tools/streaming/validation — voir [tool use Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) et [function calling OpenAI](https://platform.openai.com/docs/guides/function-calling)) ; `assistant-ui` n'est pas un concurrent mais une **couche UI** à brancher sur AI SDK si `useChat` maison ne suffit plus.

## Tableau comparatif (12 critères)

| Critère | Vercel AI SDK | LangGraph.js | SDK direct | Source |
|---|---|---|---|---|
| Tool-calling | `tool({ description, inputSchema (Zod), execute })`, validation SDK, `execute` optionnel (délégation client/queue) | tools par nœud, graphe explicite | `input_schema` (Anthropic) / `tools` (OpenAI) à câbler main | [AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [OpenAI](https://platform.openai.com/docs/guides/function-calling) |
| Structured output | `Output.object({ schema })` combinable aux tools dans le même appel | sortie structurée par nœud / structured output LangChain | JSON mode manuel + validation maison | [AI SDK structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) |
| Multi-steps | `stopWhen: isStepCount(5)`, `ToolLoopAgent` (contexte, conditions d'arrêt) | graphe de steps, contrôle total | boucle maison à écrire | [AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [agents](https://ai-sdk.dev/docs/agents/overview) |
| Streaming | `streamText` + `useChat` (transport `DefaultChatTransport`, `/api/chat` par défaut, `fetch` injectable) | streaming par nœud/canal | SSE manuel (`stream: true`) | [useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat), [generating text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text) |
| Annulation | `AbortSignal` standard du web (`fetch`, `streamText`), bouton stop côté `useChat` | annulation par thread/run côté serveur | `AbortController` manuel | [useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) |
| Reprise | `resumeStreamIsReplay` + persistance historique à nous (Store/SQLite) | checkpoints + `thread_id`, reprise/time-travel natifs | à construire | [useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) |
| Mémoire / contexte long | `runtimeContext` + `toolsContext` par tool ; historique carte = messages persistés côté Tauri | mémoire court/long terme + checkpoints du graphe | historique manuel | [agents](https://ai-sdk.dev/docs/agents/overview) |
| Approvals humaines | **suffisant pour notre modèle** : `execute` absent = tool forwardé en approbation ; notre règle « 1 approval = 1 `batch_execute` » (`docs/mcp-approvals.md`) se mappe sur UN tool `batch_execute` exposé au modèle | `interrupt()` / reprise par `Command`, HITL par nœud, plus fin mais plus lourd | modal maison avant `tools/call` | [agents](https://ai-sdk.dev/docs/agents/overview), `docs/mcp-approvals.md` |
| Observabilité | OpenTelemetry via `@ai-sdk/otel` | LangSmith (traces + evals) | logs maison | [telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry), [LangSmith evals](https://docs.langchain.com/langsmith/evaluation-concepts) |
| Tests / evals | `MockLanguageModelV4` + `simulateReadableStream`, déterministe sans réseau | framework d'evals LangSmith (SaaS, overkill au démarrage) | mocks maison | [testing](https://ai-sdk.dev/docs/ai-sdk-core/testing), [evals](https://docs.langchain.com/langsmith/evaluation-concepts) |
| Taille bundle / compat | `ai` + 1–2 providers, tree-shakable ; pur `fetch`+`ReadableStream` → OK WebView Tauri/WebKitGTK Linux, **aucun WebGPU requis** | `@langchain/*` + graphe → plus lourd, disproportionné | le plus léger | [Tauri frontend](https://v2.tauri.app/start/frontend/) |
| Offline-first | compatible : tools locaux exécutés sans réseau ; même discipline que `sourcing.ts` | compatible mais checkpoints serveur compliquent le mode offline | compatible, tout est manuel | `pcb-mcp/src/sourcing.ts`, `pcb-mcp/src/compile.ts` |

## Détail par stack

### A. Vercel AI SDK (recommandé par défaut)

- **Tool-calling / structured output.** `tool({ description, inputSchema: z.object({...}), execute })` ; le schéma Zod est consommé par le LLM **et** valide les appels ; `execute` optionnel permet de forwarder l'appel au lieu de l'exécuter ([tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)). Structured output via `output: Output.object({ schema })`, combinable avec les tools ([structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)).
- **Multi-steps.** `stopWhen: isStepCount(5)` borne la boucle ; `ToolLoopAgent` gère boucle + contexte + arrêts ([agents](https://ai-sdk.dev/docs/agents/overview)).
- **Streaming / annulation / reprise.** `streamText` + `useChat` avec transport configurable (`fetch`/`headers`/`body`, `resumeStreamIsReplay`) ([useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)). Annulation = `AbortSignal` web standard.
- **Approvals (point clé Nia).** Exposer **un seul tool `batch_execute`** au modèle (schéma Zod des ops), `execute` = handler qui (1) demande l'approbation, (2) appelle le MCP local, (3) renvoie le résultat (patch+live, rollback déjà testé). `preview_screenshot`/`search_parts`/`run_checks` restent read-only donc sans approval.
- **Mémoire / contexte long.** `runtimeContext` + `toolsContext` ([agents](https://ai-sdk.dev/docs/agents/overview)). Historique persisté via Store/SQLite Tauri.
- **Observabilité.** `registerTelemetry` OpenTelemetry ([telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)).
- **Tests.** `MockLanguageModelV4` déterministe sans réseau ([testing](https://ai-sdk.dev/docs/ai-sdk-core/testing)).
- **MCP.** Support client MCP natif ([mcp-tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)).
- **Limites.** Pas de checkpoints/time-travel natifs ; pas de studio visuel ; HITL moins fin que LangGraph (inutile ici vu « 1 approval = 1 lot »).

### B. LangGraph.js (alternative si graphes longs)

- **Forces.** Graphe explicite, checkpoints + `thread_id`, `interrupt()` + reprise pour HITL fin, streaming par canal, LangSmith (traces + evals) ([evals](https://docs.langchain.com/langsmith/evaluation-concepts)).
- **Coûts pour Nia.** Runtime plus lourd, modèle graphe pour une **boucle simple**, persistance à opérer (complique offline-first), HITL par nœud en porte-à-faux avec « 1 approval = 1 lot ».

### C. SDK direct / autres (écartés)

- **SDK Anthropic/OpenAI direct** ([Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [OpenAI](https://platform.openai.com/docs/guides/function-calling)) : contrôle maximal ; mais boucle/streaming/validation à réinventer.
- **assistant-ui** : couche UI React, pas un runtime ; se branche sur AI SDK si `useChat` maison plafonne.

## Adéquation Tauri / WebKitGTK Linux / offline-first

- Tauri frontend-agnostique, IPC par `invoke`/événements ([frontend](https://v2.tauri.app/start/frontend/), [calling Rust](https://v2.tauri.app/develop/calling-rust/)) ; AI SDK ne demande que `fetch` + `ReadableStream` — **pas de WebGPU**, pas de Node embarqué.
- Existant offline-first à préserver : `compileTsx` local, `sourcing.ts` refuse explicitement hors-ligne. Le chat applique la même discipline.
- Transport recommandé au POC : `DefaultChatTransport` avec `fetch` injecté vers (a) sidecar MCP HTTP local en dev, (b) commande Tauri en prod.

## Réversibilité et coût de changement d'avis

- **Isoler le SDK derrière un seam `AgentChat`** (interface : `send(messages, tools)`, `abort()`, `resume()`, `approve(batch)`). Schémas Zod/JSON versionnés.
- **AI SDK → LangGraph** : coût moyen — réécrire la boucle, migrer l'historique, re-câbler approvals.
- **AI SDK → SDK direct** : coût faible.
- **Critère de bascule** : passer à LangGraph uniquement si ≥2 signaux : (1) boucles >10 steps avec branchements, (2) time-travel multi-jours, (3) HITL multi-acteurs, (4) evals LangSmith indispensables.

## Plan de validation (POC, pas d'implémentation dans ce ticket)

1. POC `useChat` + `DefaultChatTransport(fetch Tauri)` + 1 tool `batch_execute` mocké ; mesurer bundle et streaming sous WebKitGTK Linux.
2. Brancher `preview_screenshot` (read-only) + `search_parts` (refus offline) via MCP.
3. Valider l'approval unique par lot + rollback, télémétrie OTel.
4. Décision go/no-go vers implémentation (nouveau ticket).
