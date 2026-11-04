// Binding React de l'Agent intégré (seule surface UI autorisée).
//
// Les composants n'importent JAMAIS `ai` : ce hook expose la vue étroite
// `AgentChat` (messages, streaming partiel, approbations, consentement,
// modèle/mode, compaction) et pilote la session. Le SDK vit dans
// `agentFactory.ts` (boucle, outils, arrêt) — jamais dans les composants.
//
// Écart documenté à la stack (justifié) : pas de `useChat` en T6. `useChat`
// exigerait un second moteur de tour (mapping messages, persistance,
// compaction) non testable sans jsdom et divergent du cœur testé ; la
// session pilote le MÊME `ToolLoopAgent` en streaming (`agent.stream()` +
// `AbortSignal`), avec la même surface (envoi/stop/reprise). La migration
// vers `useChat` reste triviale : `DirectChatTransport({ agent:
// createLoopAgent(...) })`, pièces inchangées.

import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  createAgentSession,
  DEFAULT_BUDGET_TOKENS,
  type AgentChat,
} from "./session";
import { createApprovalGate } from "./tools";
import { createBoardReader, createProdComplete, createRouterExecutor } from "./prod";
import { listModels, DEFAULT_MODEL_ID } from "./models";
import { TauriMetaModel } from "./tauriModel";
import { estimateTokens } from "./store";

export interface AgentChatView {
  messages: AgentChat["messages"];
  partial: string | null;
  pending: AgentChat["pending"];
  status: AgentChat["status"];
  needsConsent: boolean;
  consentSummary: string;
  degraded: string | null;
  model: string;
  models: string[];
  modelsFallback: boolean;
  mode: AgentChat["mode"];
  compactionPct: number;
  working: boolean;
  send: (text: string) => void;
  stop: () => void;
  approve: (toolCallId: string) => void;
  reject: (toolCallId: string, reason?: string) => void;
  resume: () => void;
  setModel: (modelId: string) => void;
  setMode: (mode: AgentChat["mode"]) => void;
  giveConsent: () => void;
  newConversation: () => void;
}

function browserStorage(): Storage {
  return window.localStorage;
}

/** Une session par Projet ouvert (conversations isolées par Projet). */
export function useAgentChat(projectPath: string | null): AgentChatView {
  const modelsInfo = useMemo(() => listModels(), []);
  const gate = useMemo(() => createApprovalGate(), [projectPath]);
  const prod = useMemo(
    () => ({
      complete: createProdComplete(),
      execute: createRouterExecutor(),
      readBoard: createBoardReader(),
    }),
    [],
  );
  const sessionRef = useRef<{ project: string | null; session: AgentChat } | null>(null);
  if (sessionRef.current === null || sessionRef.current.project !== projectPath) {
    sessionRef.current = {
      project: projectPath,
      session: createAgentSession({
        projectPath,
        modelId: DEFAULT_MODEL_ID,
        storage: browserStorage(),
        gate,
        readBoard: prod.readBoard,
        executeLot: prod.execute,
        modelFor: (modelId) => new TauriMetaModel({ modelId, complete: prod.complete }),
      }),
    };
  }
  const session = sessionRef.current.session;
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => session.subscribe(bump), [session]);

  const compactionPct = Math.min(
    100,
    Math.round(
      (estimateTokens(session.messages.map((m) => `${m.role}:${m.text}`).join("\n")) / DEFAULT_BUDGET_TOKENS) * 100,
    ),
  );

  return {
    messages: session.messages,
    partial: session.partial,
    pending: session.pending,
    status: session.status,
    needsConsent: session.needsConsent,
    consentSummary: session.consentSummary,
    degraded: session.degraded,
    model: session.model || DEFAULT_MODEL_ID,
    models: modelsInfo.models,
    modelsFallback: modelsInfo.fallback,
    mode: session.mode,
    compactionPct,
    working: session.status === "working" || session.status === "awaiting-approval",
    send: (text: string) => void session.send(text),
    stop: () => session.stop(),
    approve: (id: string) => session.approve(id),
    reject: (id: string, reason?: string) => session.reject(id, reason),
    resume: () => void session.resume(),
    setModel: (id: string) => session.setModel(id),
    setMode: (m) => session.setMode(m),
    giveConsent: () => session.giveConsent(),
    newConversation: () => session.newConversation(),
  };
}
