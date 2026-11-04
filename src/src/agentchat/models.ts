// Couture S1 : modèles Meta (sélecteur du chat).
//
// Liste live (spec #55 US7/US9) : commande backend `llm_models`
// (`GET /v1/models` via allowlist, coût nul, clé du vault côté backend).
// Échec live (pas de Projet ouvert, pas de clé, refus, liste vide) → repli
// codé ci-dessous, conservé et versionné (utilisable sans réseau ni clé).
// Le sélecteur affiche « modèles (repli) » dans ce cas (voir AgentDrawer).

/** Modèle par défaut (ticket T6, modèle Meta). */
export const DEFAULT_MODEL_ID = "muse-spark-1.3";

/** Repli hors-ligne versionné (utilisable sans réseau ni clé). */
export const FALLBACK_MODELS: readonly string[] = [DEFAULT_MODEL_ID];

export interface ModelListResult {
  models: string[];
  /** `true` = repli codé (liste live indisponible ou vide, voir en-tête). */
  fallback: boolean;
}

/** Liste des modèles : repli codé (seam synchrone des tests + boot). */
export function listModels(): ModelListResult {
  return { models: [...FALLBACK_MODELS], fallback: true };
}

/**
 * Liste live via la commande backend `llm_models` (injectée pour les tests).
 * Jamais de throw : tout échec (ou liste vide) retombe sur le repli codé.
 */
export async function loadModelList(fetchLive: () => Promise<string[]>): Promise<ModelListResult> {
  try {
    const seen = new Set<string>();
    for (const raw of await fetchLive()) {
      const id = (raw ?? "").trim();
      if (id && !seen.has(id)) seen.add(id);
    }
    if (seen.size === 0) return listModels();
    return { models: [...seen], fallback: false };
  } catch {
    return listModels();
  }
}

/**
 * `true` ssi le modèle suit le protocole lot (`batch_execute`, US10).
 * Le tool-calling est émulé au niveau prompt (clôture ```batch_execute) :
 * seuls les modèles Meta `muse-spark-*` la suivent de façon fiable ; tout
 * autre identifiant (ex. modèle local Ollama) répond en texte seul avec un
 * bandeau explicite — jamais d'appel outil fantôme.
 */
export function supportsToolCalling(modelId: string): boolean {
  return modelId.trim().startsWith("muse-spark-");
}
