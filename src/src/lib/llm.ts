import { invoke } from "@tauri-apps/api/core";

/** Statut exposé par le backend T4 BYOK (ticket #58) : masque + métadonnées.
 *  La clé ne traverse JAMAIS vers le frontend — ni ici, ni en store,
 *  ni en localStorage (ne rien y persister : le statut se relit via
 *  `llmStatus()` à chaque montage). */
export interface LlmStatus {
  configured: boolean;
  /** Masque `••••1234` (4 derniers) affiché à l'utilisateur. */
  mask: string;
  /** RFC3339 de la dernière vérification réussie, `null` si jamais. */
  verifiedAt: string | null;
  /** Modèle par défaut (liste réelle via `GET /v1/models`, repli `default`). */
  model: string;
  /** Télémétrie d'usage : opt-in explicite, défaut `false`. */
  telemetryOptIn: boolean;
  /** Jetons consommés cette session (budget visible). */
  sessionTokens: number;
}

export interface LlmChatReply {
  text: string;
  tokensUsed: number;
  model: string;
}

export type LlmChatMode = "chat" | "responses";

export interface LlmChatRequest {
  model: string;
  input: string;
  maxTokens: number;
  /** Récapitulatif pré-envoi validé par l'utilisateur (opt-in, G5). */
  consent: boolean;
  mode: LlmChatMode;
}

/** Lecture seule, aucun secret, aucun réseau : utilisable sans Projet ouvert. */
export async function llmStatus(): Promise<LlmStatus> {
  return (await invoke("llm_status")) as LlmStatus;
}

/** Vérifie (GET /v1/models, coût nul) puis chiffre et persiste.
 *  Exige un Projet ouvert (`NO_PROJECT_OPEN` sinon). L'ancienne clé n'est
 *  écrasée que si la nouvelle est acceptée — Remplacer = même appel. */
export async function llmVerifyAndSave(key: string): Promise<LlmStatus> {
  return (await invoke("llm_verify_and_save", { key })) as LlmStatus;
}

/** Re-vérifie la clé stockée sans l'écraser. 401 → « rouvre les Paramètres ». */
export async function llmTest(): Promise<LlmStatus> {
  return (await invoke("llm_test")) as LlmStatus;
}

/** Supprime le vault (`true` si un vault existait). Confirmation côté UI. */
export async function llmClear(): Promise<boolean> {
  return (await invoke("llm_clear")) as boolean;
}

/** Télémétrie d'usage : opt-in explicite (défaut `false`, G8). */
export async function llmSetTelemetry(optin: boolean): Promise<LlmStatus> {
  return (await invoke("llm_set_telemetry", { optin })) as LlmStatus;
}

/** Commande dédiée unique autorisée à appeler le LLM (appelant futur de
 *  l'Agent intégré + Tester). Consentement + budgets appliqués côté backend. */
export async function llmComplete(req: LlmChatRequest): Promise<LlmChatReply> {
  return (await invoke("llm_complete", { req })) as LlmChatReply;
}

/** Vrai si l'erreur backend = garde G3 (aucun appel sans Projet ouvert). */
export function isNoProjectOpen(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("NO_PROJECT_OPEN");
}

/** Vrai si l'erreur backend demande de rouvrir les Paramètres (clé refusée).
 *  Pilote le bandeau chat « clé refusée — rouvre les Paramètres ». */
export function isKeyRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("rouvre les Paramètres");
}

/** Message affichable (le backend parle déjà français et précis). */
export function llmErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
