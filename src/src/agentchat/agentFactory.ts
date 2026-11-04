// Fabrique partagée de l'agent (session déterministe + chemin UI streaming).
//
// UNE seule définition de la boucle : `ToolLoopAgent` (`stopWhen:
// stepCountIs(5)`, UN tool `batch_execute` Zod, instructions injectées).
// - la session (`session.ts`) pilote via `agent.generate(...)` (testable,
//   `MockLanguageModelV4`, zéro réseau) ;
// - le hook UI (`useAgentChat.ts`) pilote le MÊME agent via
//   `DirectChatTransport` + `useChat` (streaming, Stop, reprise).
// L'UI ne touche jamais à cette fabrique : elle passe par le hook.

import { stepCountIs, ToolLoopAgent, type LanguageModel } from "ai";
import { buildInstructions } from "./prompt";
import {
  createBatchExecuteTool,
  type ApprovalGate,
  type LotExecutor,
} from "./tools";
import type { ApprovalMode } from "./store";

export interface AgentPiecesDeps {
  model: LanguageModel;
  gate: ApprovalGate;
  execute: LotExecutor;
  getMode: () => ApprovalMode;
  boardSummary: string;
  compactionNotes?: string[];
  /** `false` = modèle sans tool-calling (US10) : aucun tool offert, texte seul. */
  toolsSupported?: boolean;
}

/** UN agent, deux pilotes (generate déterministe / Chat streaming). */
export function createLoopAgent(deps: AgentPiecesDeps) {
  const instructions = [
    buildInstructions({ boardSummary: deps.boardSummary }),
    ...(deps.compactionNotes ?? []).map((n) => `[contexte compacté] ${n}`),
  ].join("\n\n");
  // US10 : modèle sans tool-calling → aucun tool offert (texte seul explicite).
  const tools: Record<string, ReturnType<typeof createBatchExecuteTool>> = {};
  if (deps.toolsSupported !== false) {
    tools.batch_execute = createBatchExecuteTool({
      gate: deps.gate,
      execute: deps.execute,
      getMode: deps.getMode,
    });
  }
  return new ToolLoopAgent({
    model: deps.model,
    tools,
    instructions,
    stopWhen: stepCountIs(5),
  });
}
