// Seam étroit AgentChat (l'UI ne parle JAMAIS au SDK en direct).
//
// La boucle multi-tours + outils + arrêt est DÉLÉGUÉE au SDK via la
// fabrique partagée (`agentFactory.ts` : UN `ToolLoopAgent`,
// `stopWhen: stepCountIs(5)`, UN tool, `AbortSignal`) ; la Conversation pilote
// via `agent.generate(...)`, le hook UI pilote le MÊME agent via
// `DirectChatTransport` + `useChat` — mêmes pièces, mêmes règles.
// Zéro réseau ici (modèle et routeur injectés) ; garde G3 (aucun appel
// sans Projet ouvert) ; consentement opt-in pré-envoi.

import type { LanguageModel } from "ai";
import { createLoopAgent } from "./agentFactory";
import { AGENT_CHAT_SCHEMA_VERSION } from "./schemas";
import { DEFAULT_MODEL_ID, supportsToolCalling } from "./models";
import {
  compactConversation,
  conversationSessionId,
  conversationTokens,
  estimateTokens,
  loadConversation,
  newConversation,
  saveConversation,
  type ApprovalMode,
  type ChatMessage,
  type Conversation,
  type StorageLike,
} from "./store";
import {
  type ApprovalGate,
  type LotOutcome,
  type LotExecutor,
} from "./tools";

export const NO_PROJECT_OPEN_MSG =
  "NO_PROJECT_OPEN : ouvre un Projet pour activer l'Agent intégré — aucun appel LLM sans Projet ouvert";

/** Budget contexte par défaut (≈ 24 000 caractères / 4, comme le backend). */
export const DEFAULT_BUDGET_TOKENS = 6000;

export type ConversationStatus = "idle" | "working" | "awaiting-approval" | "error";

export interface BoardSnapshot {
  summary: string;
  mainLines: number;
  elements: number;
}

export interface ConversationDeps {
  projectPath: string | null;
  modelId: string;
  storage: StorageLike;
  gate: ApprovalGate;
  /** Lecture libre (état carte) — jamais de throw contractuel ? si, catch ici. */
  readBoard: () => Promise<BoardSnapshot>;
  executeLot: LotExecutor;
  modelFor: (modelId: string) => LanguageModel;
  budgetTokens?: number;
  /** Hydratation asynchrone (coffre chiffré) : prioritaire sur `storage`. */
  initialConversation?: Conversation;
  /** Persistance asynchrone (coffre chiffré) : remplace `storage` si fournie. */
  persistSink?: (projectPath: string, conv: Conversation) => void | Promise<void>;
}

export interface AgentChat {
  messages: ChatMessage[];
  pending: { toolCallId: string; operations: unknown[] }[];
  status: ConversationStatus;
  /** Identifiant stable de la Conversation (sessionId généralisé). */
  conversationId: string;
  /** Texte partiel en cours de streaming (`null` hors streaming). */
  partial: string | null;
  needsConsent: boolean;
  consentSummary: string;
  degraded: string | null;
  model: string;
  mode: ApprovalMode;
  send(text: string): Promise<void>;
  stop(): void;
  approve(toolCallId: string): void;
  reject(toolCallId: string, reason?: string): void;
  resume(): Promise<void>;
  setModel(modelId: string): void;
  setMode(mode: ApprovalMode): void;
  giveConsent(): void;
  newConversation(): void;
  subscribe(fn: () => void): () => void;
}

export function createAgentConversation(deps: ConversationDeps): AgentChat {
  const budget = deps.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  let projectPath = deps.projectPath;
  let conv: Conversation = projectPath
    ? (() => {
        if (deps.initialConversation && deps.initialConversation.projectPath === projectPath) {
          const init = deps.initialConversation;
          if (!init.model) init.model = deps.modelId || DEFAULT_MODEL_ID;
          return init;
        }
        const loaded = loadConversation(deps.storage, projectPath as string);
        if (!loaded.model) loaded.model = deps.modelId || DEFAULT_MODEL_ID;
        return loaded;
      })()
    : newConversation("", deps.modelId || DEFAULT_MODEL_ID);
  let status: ConversationStatus = "idle";
  let degraded: string | null = null;
  let needsConsent = false;
  let consentSummary = "";
  let abortedTurn: string | null = null;
  let ctrl: AbortController | null = null;
  let turnOutcomes: LotOutcome[] = [];
  let partial: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());

  function persist() {
    if (!projectPath) return;
    if (deps.persistSink) {
      try {
        const out = deps.persistSink(projectPath, conv);
        if (out && typeof (out as Promise<void>).catch === "function") {
          (out as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Persistance best-effort : la Conversation vit en mémoire.
      }
    } else {
      saveConversation(deps.storage, projectPath, conv);
    }
    notify();
  }

  function setStatus(s: ConversationStatus) {
    status = s;
    notify();
  }

  async function boardSnapshot(): Promise<BoardSnapshot> {
    try {
      return await deps.readBoard();
    } catch {
      return {
        summary: "état carte indisponible (sidecar éteint ou hors-ligne) — réponses en dégradé, aucune écriture.",
        mainLines: 0,
        elements: 0,
      };
    }
  }

  async function runTurn(userText: string, opts?: { replayUser?: boolean }): Promise<void> {
    if (!projectPath || !projectPath.trim()) throw new Error(NO_PROJECT_OPEN_MSG);
    if (!conv.consent) {
      const snap = await boardSnapshot();
      consentSummary =
        `Ce prompt enverra main.tsx (≈ ${snap.mainLines} lignes) et ${snap.elements} éléments circuit-json au modèle ${conv.model}. ` +
        "Chemins relativisés, previews/exports exclus. Envoi après opt-in — Annulable.";
      needsConsent = true;
      notify();
      return;
    }
    needsConsent = false;
    // Compaction AVANT l'appel (seuil 80 %), sur l'historique existant.
    if (conversationTokens(conv) >= Math.floor(budget * 0.8)) {
      const out = compactConversation(conv, budget);
      conv = out.conversation;
    }
    if (!opts?.replayUser) {
      conv.messages.push({ id: `u-${Date.now()}`, role: "user", text: userText });
    }
    persist();
    turnOutcomes = [];
    abortedTurn = null;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    setStatus("working");

    const snap = await boardSnapshot();
    const systems = conv.messages.filter((m) => m.role === "system").map((m) => m.text);
    const history = conv.messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.text,
    }));

    const wrappedExecute: LotExecutor = async (input) => {
      try {
        // sessionId généralisé : l'id de Conversation, sauf session explicite
        // du modèle (schéma inchangé, repli `default` côté routeur).
        const outcome = await deps.executeLot({ operations: input.operations, sessionId: input.sessionId ?? conversationSessionId(conv) });
        turnOutcomes.push(outcome);
        setStatus("working");
        return outcome;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const outcome: LotOutcome = {
          applied: false,
          rolledBack: false,
          errors: 1,
          message: `sidecar éteint ou injoignable — dégradé, aucune modification appliquée (${message})`,
          code: null,
        };
        turnOutcomes.push(outcome);
        setStatus("working");
        return outcome;
      }
    };

    try {
      const toolsSupported = supportsToolCalling(conv.model || DEFAULT_MODEL_ID);
      const agent = createLoopAgent({
        model: deps.modelFor(conv.model || DEFAULT_MODEL_ID),
        gate: deps.gate,
        execute: wrappedExecute,
        getMode: () => conv.mode,
        boardSummary: snap.summary,
        compactionNotes: systems,
        toolsSupported,
      });
      // La porte expose l'attente à l'UI : dès qu'un lot est proposé, le
      // statut passe en `awaiting-approval` (sondage léger ci-dessous).
      const watch = setInterval(() => {
        if (deps.gate.list().length > 0 && status === "working") setStatus("awaiting-approval");
        else if (deps.gate.list().length === 0 && status === "awaiting-approval") setStatus("working");
      }, 60);
      try {
        // Streaming réel (même agent que le chemin `useChat` : boucle,
        // outils et arrêt restent 100 % SDK). Le texte partiel est exposé
        // via `partial` (non bloquant + Stop entre chunks).
        const streamed = await agent.stream({
          messages: history,
          abortSignal: signal,
        });
        let text = "";
        for await (const delta of streamed.textStream) {
          if (signal.aborted) break;
          text += delta;
          partial = text;
          notify();
        }
        const last = turnOutcomes[turnOutcomes.length - 1];
        // Stop pendant le tour : le SDK convertit l'abort en erreur d'outil
        // et termine le tour — on jette ce tour avorté (reprise sans doublon).
        if (signal.aborted) {
          abortedTurn = userText;
          partial = null;
          return;
        }
        partial = null;
        const finalText = text.trim() || (last?.applied ? "(lot appliqué — voir le détail ci-dessous)" : "(réponse vide du modèle)");
        conv.messages.push({
          id: `a-${Date.now()}`,
          role: "assistant",
          text: finalText,
          model: conv.model,
          lot: last
            ? { applied: last.applied, rolledBack: last.rolledBack, errors: last.errors, message: last.message }
            : null,
        });
        // US10 : modèle sans tool-calling → réponse texte seule + bandeau
        // explicite (l'outil ne lui est jamais offert, aucun appel fantôme).
        degraded = !toolsSupported
          ? `« ${conv.model} » ne supporte pas les Lots — réponse en texte seul, sans modification de la carte. Choisis un modèle Meta (ex. ${DEFAULT_MODEL_ID}) pour proposer des lots.`
          : turnOutcomes.length === 0
            ? "réponse texte seule (aucun outil appelé) — reformule ou change de modèle si tu attendais une modification."
            : null;
      } finally {
        clearInterval(watch);
      }
      // Compaction post-tour : le seuil 80 % peut être franchi par le tour
      // qui vient de s'ajouter (le prochain envoi resterait sinon au-dessus).
      if (conversationTokens(conv) >= Math.floor(budget * 0.8)) {
        conv = compactConversation(conv, budget).conversation;
      }
      setStatus("idle");
      persist();
    } catch (e) {
      partial = null;
      if ((e as Error)?.name === "AbortError" || signal.aborted) {
        abortedTurn = userText;
        setStatus("idle");
        persist();
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      degraded = message;
      conv.messages.push({
        id: `a-${Date.now()}`,
        role: "assistant",
        text: `Appel modèle impossible en dégradé : ${message} — la carte n'a pas été modifiée. Tes fichiers restent intacts.`,
        model: conv.model,
        lot: null,
      });
      setStatus("idle");
      persist();
    } finally {
      ctrl = null;
    }
  }

  return {
    get messages() { return conv.messages; },
    get pending() { return deps.gate.list(); },
    get status() { return status; },
    get conversationId() { return conversationSessionId(conv); },
    get partial() { return partial; },
    get needsConsent() { return needsConsent; },
    get consentSummary() { return consentSummary; },
    get degraded() { return degraded; },
    get model() { return conv.model; },
    get mode() { return conv.mode; },

    async send(text: string): Promise<void> {
      const t = text.trim();
      if (!t || status === "working" || status === "awaiting-approval") return;
      await runTurn(t);
    },
    stop() {
      ctrl?.abort();
      setStatus("idle");
    },
    approve(toolCallId: string) {
      deps.gate.approve(toolCallId);
      notify();
    },
    reject(toolCallId: string, reason?: string) {
      deps.gate.reject(toolCallId, reason);
      notify();
    },
    async resume() {
      if (status === "working" || status === "awaiting-approval") return;
      // Rejoue le dernier message utilisateur (tour interrompu par Stop).
      const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return;
      // Retire tout ce qui suit (assistant incomplet) puis rejoue sans doublon.
      const idx = conv.messages.lastIndexOf(lastUser);
      conv.messages = conv.messages.slice(0, idx + 1);
      abortedTurn = null;
      await runTurn(lastUser.text, { replayUser: true });
    },
    setModel(modelId: string) {
      conv.model = modelId; // historique partagé, étiquette par message
      persist();
    },
    setMode(mode: ApprovalMode) {
      conv.mode = mode;
      persist();
    },
    giveConsent() {
      conv.consent = true;
      needsConsent = false;
      persist();
    },
    newConversation() {
      const fresh = newConversation(projectPath ?? "", conv.model || DEFAULT_MODEL_ID);
      fresh.mode = conv.mode;
      fresh.consent = conv.consent;
      conv = fresh;
      degraded = null;
      needsConsent = false;
      persist();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export { AGENT_CHAT_SCHEMA_VERSION, estimateTokens };
