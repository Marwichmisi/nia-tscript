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
  type BatchExecutor,
} from "./tools";
import type { ApprovalMode } from "./store";

export interface AgentPiecesDeps {
  model: LanguageModel;
  gate: ApprovalGate;
  execute: BatchExecutor;
  getMode: () => ApprovalMode;
  boardSummary: string;
  compactionNotes?: string[];
}

/** UN agent, deux pilotes (generate déterministe / Chat streaming). */
export function createLoopAgent(deps: AgentPiecesDeps) {
  const instructions = [
    buildInstructions({ boardSummary: deps.boardSummary }),
    ...(deps.compactionNotes ?? []).map((n) => `[contexte compacté] ${n}`),
  ].join("\n\n");
  return new ToolLoopAgent({
    model: deps.model,
    tools: {
      batch_execute: createBatchExecuteTool({
        gate: deps.gate,
        execute: deps.execute,
        getMode: deps.getMode,
      }),
    },
    instructions,
    stopWhen: stepCountIs(5),
  });
}
