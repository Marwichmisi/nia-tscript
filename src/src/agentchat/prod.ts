// Câblage prod de l'Agent intégré (seul fichier qui touche au réseau/backend).
//
// - Modèle : commande T4 `llm_complete` (clé du porteur côté backend,
//   mode choisi par le wrapper — échanges simples en Chat Completions,
//   boucle en Responses —, consentement toujours `true` ici car la session
//   exige l'opt-in pré-envoi AVANT tout `send` — jamais de clé frontend).
// - Lot : routeur local T5 (`getAgentRouter().batchExecute`, parité MCP).
// - Lectures libres : `pcbState` + `hierarchy` (sans approbation).
// Aucun élargissement CSP, aucun fetch direct, garde G3 préservée.

import { getAgentRouter } from "../lib/agent";
import { llmComplete } from "../lib/llm";
import { readProjectMain } from "../lib/projects";
import type { CompleteFn } from "./tauriModel";
import type { LotExecutor } from "./tools";
import type { BoardSnapshot } from "./session";

function outcomeMessage(parsed: {
  diagnostics?: { message?: string }[];
  message?: string;
  mode?: string;
}): string {
  const d = parsed.diagnostics?.[0]?.message;
  if (d) return d;
  if (parsed.message) return parsed.message;
  return parsed.mode ?? "résultat lot indisponible";
}

/** Exécuteur de lot prod (routeur T5, atomique + rollback). */
export function createRouterExecutor(): LotExecutor {
  return async (input) => {
    const router = getAgentRouter();
    const res = await router.batchExecute({
      session_id: input.sessionId ?? "default",
      operations: input.operations as never,
    });
    let parsed: {
      applied?: boolean;
      rolledBack?: boolean;
      errors?: number;
      diagnostics?: { message?: string }[];
      message?: string;
      mode?: string;
    } = {};
    try {
      parsed = JSON.parse(res.text) as typeof parsed;
    } catch {
      parsed = {};
    }
    return {
      applied: parsed.applied === true,
      rolledBack: parsed.rolledBack === true,
      errors: typeof parsed.errors === "number" ? parsed.errors : 1,
      message: outcomeMessage(parsed),
      code: null,
    };
  };
}

/** Complétion prod (commande T4 unique ; mode choisi par le wrapper :
 *  échanges simples en Chat Completions, boucle en Responses). */
export function createProdComplete(): CompleteFn {
  return async (req, signal) => {
    if (signal?.aborted) {
      const e = new Error("génération interrompue (Stop)");
      e.name = "AbortError";
      throw e;
    }
    const reply = await llmComplete({
      model: req.model,
      input: req.input,
      maxTokens: req.maxTokens,
      consent: true,
      mode: req.mode,
    });
    if (signal?.aborted) {
      const e = new Error("génération interrompue (Stop)");
      e.name = "AbortError";
      throw e;
    }
    return { text: reply.text, tokensUsed: reply.tokensUsed };
  };
}

/** Lecture libre prod (état carte pour les instructions, sans approbation). */
export interface BoardReaderDeps {
  /** `main.tsx` du Projet ouvert (défaut : commande backend, Confinement). */
  readMain?: () => Promise<{ code: string } | null>;
  fetchState?: () => Promise<{ text: string } | null>;
  fetchHierarchy?: () => Promise<{ text: string } | null>;
}

/** Nombre de lignes TSX (newline final non compté double, vide → 0). */
export function countMainLines(code: string): number {
  if (!code) return 0;
  return code.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

export function createBoardReader(deps?: BoardReaderDeps): () => Promise<BoardSnapshot> {
  return async () => {
    const router = deps ? null : getAgentRouter();
    const [state, hier, main] = await Promise.all([
      (deps?.fetchState ?? (() => router!.pcbState().catch(() => null)))(),
      (deps?.fetchHierarchy ?? (() => router!.hierarchy().catch(() => null)))(),
      (deps?.readMain ?? (async () => readProjectMain().catch(() => null)))(),
    ]);
    let summary = "état carte indisponible (lecture locale en échec) — réponses en dégradé.";
    let elements = 0;
    try {
      const parsed = state ? (JSON.parse(state.text) as { stats?: { total?: number } }) : null;
      if (typeof parsed?.stats?.total === "number") elements = parsed.stats.total;
    } catch {
      elements = 0;
    }
    const htext = typeof hier?.text === "string" ? hier.text.slice(0, 1200) : "";
    const mainLines = main && typeof main.code === "string" ? countMainLines(main.code) : 0;
    if (state || hier) {
      summary = `main.tsx (≈ ${mainLines} lignes), éléments : ${elements}. Hiérarchie : ${htext || "(vide)"}`;
    }
    return { summary, mainLines, elements };
  };
}
