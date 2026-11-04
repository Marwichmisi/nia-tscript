// Couture S2 : conversations persistées par Projet (Agent intégré).
//
// - Une Conversation par Projet ouvert (clé `nia.agentchat.<projet>`).
// - Compaction automatique au seuil 80 % du budget : les vieux messages
//   sont remplacés par un résumé système, les derniers tours sont gardés
//   intacts sous le seuil.
// - Bouton Neuve : contexte neuf, même Projet, modèle conservé.
// Glossaire : Conversation, Mode d'approbation.

import { AGENT_CHAT_SCHEMA_VERSION } from "./schemas";

export type ApprovalMode = "manuel" | "auto";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Étiquette du modèle ayant produit le message (switch mid-conversation). */
  model?: string;
  /** Résultat du lot (approval/rollback visibles en échec). */
  lot?: LotOutcomeSummary | null;
}

export interface LotOutcomeSummary {
  applied: boolean;
  rolledBack: boolean;
  errors: number;
  message: string;
}

export interface Conversation {
  version: number;
  projectPath: string;
  model: string;
  mode: ApprovalMode;
  /** Opt-in pré-envoi (récapitulatif validé, spec #55 US30). */
  consent: boolean;
  messages: ChatMessage[];
  updatedAt: string;
}

/** Stockage injecté (prod : localStorage ; tests : mémoire). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function conversationKey(projectPath: string): string {
  return `nia.agentchat.${projectPath}`;
}

/** Estimation locale des jetons (≈ caractères / 4, même base que le backend). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function conversationTokens(conv: Conversation): number {
  return estimateTokens(conv.messages.map((m) => `${m.role}:${m.text}`).join("\n"));
}

/** Seuil de compaction : 80 % du budget contexte. */
export const COMPACTION_RATIO = 0.8;

export function newConversation(projectPath: string, model: string): Conversation {
  return {
    version: AGENT_CHAT_SCHEMA_VERSION,
    projectPath,
    model,
    mode: "manuel",
    consent: false,
    messages: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadConversation(store: StorageLike, projectPath: string): Conversation {
  const raw = store.getItem(conversationKey(projectPath));
  if (!raw) return newConversation(projectPath, "");
  try {
    const parsed = JSON.parse(raw) as Partial<Conversation>;
    if (!parsed || !Array.isArray(parsed.messages)) return newConversation(projectPath, "");
    return {
      version: AGENT_CHAT_SCHEMA_VERSION,
      projectPath,
      model: typeof parsed.model === "string" ? parsed.model : "",
      mode: parsed.mode === "auto" ? "auto" : "manuel",
      consent: parsed.consent === true,
      messages: parsed.messages.filter(
        (m): m is ChatMessage =>
          !!m && typeof m.id === "string" && typeof m.text === "string",
      ),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return newConversation(projectPath, "");
  }
}

export function saveConversation(
  store: StorageLike,
  projectPath: string,
  conv: Conversation,
): void {
  store.setItem(
    conversationKey(projectPath),
    JSON.stringify({ ...conv, projectPath, updatedAt: new Date().toISOString() }),
  );
}

export interface CompactionResult {
  conversation: Conversation;
  compacted: boolean;
}

/**
 * Compaction au seuil 80 % : si l'estimation dépasse `0.8 * budget`,
 * remplace les vieux tours par un résumé système et garde les derniers
 * tours intacts tant que l'ensemble reste sous le budget.
 */
export function compactConversation(
  conv: Conversation,
  budgetTokens: number,
): CompactionResult {
  const threshold = Math.floor(budgetTokens * COMPACTION_RATIO);
  if (conversationTokens(conv) < threshold || conv.messages.length <= 2) {
    return { conversation: conv, compacted: false };
  }
  // Garde les derniers tours sous le budget (au moins le dernier échange).
  const kept: ChatMessage[] = [];
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const cand = [conv.messages[i]!, ...kept];
    const probe = estimateTokens(cand.map((m) => `${m.role}:${m.text}`).join("\n"));
    if (probe + 120 > budgetTokens && kept.length >= 2) break;
    kept.unshift(conv.messages[i]!);
    if (kept.length >= conv.messages.length) break;
  }
  const dropped = conv.messages.length - kept.length;
  const summary: ChatMessage = {
    id: `compaction-${Date.now()}`,
    role: "system",
    text:
      `Contexte compacté à 80 % (${dropped} message(s) résumés) : ` +
      conv.messages
        .slice(0, dropped)
        .map((m) => `[${m.role}${m.model ? `:${m.model}` : ""}] ${m.text.slice(0, 120)}`)
        .join(" | ")
        .slice(0, 600),
  };
  return { conversation: { ...conv, messages: [summary, ...kept] }, compacted: true };
}
