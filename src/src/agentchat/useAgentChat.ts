// Binding React de l'Agent intégré (seule surface UI autorisée).
//
// Les composants n'importent JAMAIS `ai` : ce hook expose la vue étroite
// `AgentChat` (messages, streaming partiel, approbations, consentement,
// modèle/mode, compaction) et pilote la Conversation. Le SDK vit dans
// `agentFactory.ts` (boucle, outils, arrêt) — jamais dans les composants.
//
// Écart documenté à la stack (justifié) : pas de `useChat` en T6. `useChat`
// exigerait un second moteur de tour (mapping messages, persistance,
// compaction) non testable sans jsdom et divergent du cœur testé ;
// la Conversation pilote le MÊME `ToolLoopAgent` en streaming (`agent.stream()` +
// `AbortSignal`), avec la même surface (envoi/stop/reprise). La migration
// vers `useChat` reste triviale : `DirectChatTransport({ agent:
// createLoopAgent(...) })`, pièces inchangées.
//
// Persistance (US30) : Conversations CHIFFRÉES au repos (coffre `vault.ts`,
// jamais de PI en clair dans `localStorage`). Hydratation asynchrone au
// montage : `loading` couvre le déchiffrement, puis la session est créée
// avec `initialConversation` + `persistSink` (toutes les sauvegardes
// suivantes sont chiffrées, y compris la purge du clair legacy).

import { useEffect, useMemo, useReducer, useState } from "react";
import {
  createAgentConversation,
  DEFAULT_BUDGET_TOKENS,
  type AgentChat,
} from "./session";
import { createApprovalGate } from "./tools";
import { createBoardReader, createProdComplete, createRouterExecutor } from "./prod";
import { listModels, loadModelList, DEFAULT_MODEL_ID, type ModelListResult } from "./models";
import { TauriMetaModel } from "./tauriModel";
import { estimateTokens } from "./store";
import {
  isCryptoAvailable,
  loadConversationEncrypted,
  saveConversationEncrypted,
} from "./vault";
import { llmModels } from "../lib/llm";

export interface AgentChatView {
  /** `true` pendant le déchiffrement initial (envoi désactivé). */
  loading: boolean;
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

/** Vue vide pendant le déchiffrement (aucun envoi possible). */
function loadingView(modelsInfo: ModelListResult): AgentChatView {
  const noop = () => undefined;
  return {
    loading: true,
    messages: [],
    partial: null,
    pending: [],
    status: "idle",
    needsConsent: false,
    consentSummary: "",
    degraded: null,
    model: DEFAULT_MODEL_ID,
    models: modelsInfo.models,
    modelsFallback: modelsInfo.fallback,
    mode: "manuel",
    compactionPct: 0,
    working: false,
    send: noop,
    stop: noop,
    approve: noop,
    reject: noop,
    resume: noop,
    setModel: noop,
    setMode: noop,
    giveConsent: noop,
    newConversation: noop,
  };
}

/** Une Conversation par Projet ouvert (conversations isolées par Projet). */
export function useAgentChat(projectPath: string | null): AgentChatView {
  // Liste live via `llm_models` (US7/US9), repli codé conservé en échec.
  const [modelsInfo, setModelsInfo] = useState<ModelListResult>(() => listModels());
  useEffect(() => {
    let stop = false;
    void loadModelList(llmModels).then((info) => {
      if (!stop) setModelsInfo(info);
    });
    return () => {
      stop = true;
    };
  }, []);
  const gate = useMemo(() => createApprovalGate(), [projectPath]);
  const prod = useMemo(
    () => ({
      complete: createProdComplete(),
      execute: createRouterExecutor(),
      readBoard: createBoardReader(),
    }),
    [],
  );
  const [conversation, setConversation] = useState<AgentChat | null>(null);
  useEffect(() => {
    let stop = false;
    const base = {
      projectPath,
      modelId: DEFAULT_MODEL_ID,
      gate,
      readBoard: prod.readBoard,
      executeLot: prod.execute,
      modelFor: (modelId: string) => new TauriMetaModel({ modelId, complete: prod.complete }),
    };
    (async () => {
      // Sans WebCrypto ou sans Projet : session synchrone immédiate (jamais
      // de PI persistée sans chiffrement quand le coffre est disponible).
      if (!isCryptoAvailable() || !projectPath) {
        if (!stop) {
          setConversation(
            createAgentConversation({ ...base, storage: browserStorage() }),
          );
        }
        return;
      }
      try {
        const initial = await loadConversationEncrypted(browserStorage(), projectPath, DEFAULT_MODEL_ID);
        if (stop) return;
        setConversation(
          createAgentConversation({
            ...base,
            storage: browserStorage(),
            initialConversation: initial,
            persistSink: (p, c) => saveConversationEncrypted(browserStorage(), p, c),
          }),
        );
        // Purge immédiate de tout clair legacy restant (réécriture chiffrée).
        void saveConversationEncrypted(browserStorage(), projectPath, initial).catch(() => undefined);
      } catch {
        if (!stop) {
          setConversation(createAgentConversation({ ...base, storage: browserStorage() }));
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [projectPath, gate, prod]);

  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => (conversation ? conversation.subscribe(bump) : undefined), [conversation]);

  if (!conversation) return loadingView(modelsInfo);

  const compactionPct = Math.min(
    100,
    Math.round(
      (estimateTokens(conversation.messages.map((m) => `${m.role}:${m.text}`).join("\n")) / DEFAULT_BUDGET_TOKENS) * 100,
    ),
  );

  return {
    loading: false,
    messages: conversation.messages,
    partial: conversation.partial,
    pending: conversation.pending,
    status: conversation.status,
    needsConsent: conversation.needsConsent,
    consentSummary: conversation.consentSummary,
    degraded: conversation.degraded,
    model: conversation.model || DEFAULT_MODEL_ID,
    models: modelsInfo.models,
    modelsFallback: modelsInfo.fallback,
    mode: conversation.mode,
    compactionPct,
    working: conversation.status === "working" || conversation.status === "awaiting-approval",
    send: (text: string) => void conversation.send(text),
    stop: () => conversation.stop(),
    approve: (id: string) => conversation.approve(id),
    reject: (id: string, reason?: string) => conversation.reject(id, reason),
    resume: () => void conversation.resume(),
    setModel: (id: string) => conversation.setModel(id),
    setMode: (m) => conversation.setMode(m),
    giveConsent: () => conversation.giveConsent(),
    newConversation: () => conversation.newConversation(),
  };
}
