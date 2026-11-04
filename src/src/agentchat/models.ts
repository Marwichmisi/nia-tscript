// Couture S1 : modèles Meta (sélecteur du chat).
//
// Repli codé (spec #55 US9) : la liste live `GET /v1/models` n'a AUCUN
// canal autorisé en T6 — `agent_fetch` est verrouillé JLC (backend) et
// aucune commande backend ne renvoie la liste (`llm_verify_and_save` /
// `llm_test` la consomment en interne sans l'exposer ; `src-tauri`
// intouchable dans ce ticket). Le sélecteur utilise donc le repli codé
// ci-dessous et reste prêt pour une future commande `llm_models`.
// Écart documenté, signalé au lead.

/** Modèle par défaut (ticket T6). */
export const DEFAULT_MODEL_ID = "muse-spark-1.3";

/** Repli hors-ligne versionné (utilisable sans réseau ni clé). */
export const FALLBACK_MODELS: readonly string[] = [DEFAULT_MODEL_ID];

export interface ModelListResult {
  models: string[];
  /** `true` = repli codé (liste live indisponible en T6, voir en-tête). */
  fallback: boolean;
}

/** Liste des modèles : repli codé en T6 (aucun canal live autorisé). */
export function listModels(): ModelListResult {
  return { models: [...FALLBACK_MODELS], fallback: true };
}
