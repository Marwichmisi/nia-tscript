// Câblage prod de l'Agent intégré (seul fichier qui touche au réseau/backend).
//
// - Modèle : commande T4 `llm_complete` (clé du porteur côté backend,
//   `mode: "responses"`, consentement toujours `true` ici car la session
//   exige l'opt-in pré-envoi AVANT tout `send` — jamais de clé frontend).
// - Lot : routeur local T5 (`getAgentRouter().batchExecute`, parité MCP).
// - Lectures libres : `pcbState` + `hierarchy` (sans approbation).
// Aucun élargissement CSP, aucun fetch direct, garde G3 préservée.

import { getAgentRouter } from "../lib/agent";
import { llmComplete } from "../lib/llm";
import type { CompleteFn } from "./tauriModel";
import type { BatchExecutor } from "./tools";
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
export function createRouterExecutor(): BatchExecutor {
  return async (input) => {
    const router = getAgentRouter();
    const res = await router.batchExecute({
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

/** Complétion prod (commande T4 unique, boucle en Responses). */
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
      mode: "responses",
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
export function createBoardReader(): () => Promise<BoardSnapshot> {
  return async () => {
    const router = getAgentRouter();
    const [state, hier] = await Promise.all([
      router.pcbState().catch(() => null),
      router.hierarchy().catch(() => null),
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
    if (state || hier) {
      summary = `éléments : ${elements}. Hiérarchie : ${htext || "(vide)"}`;
    }
    return { summary, mainLines: 0, elements };
  };
}
