// Coutures S1 (pures, testées) : schémas versionnés de l'Agent intégré.
//
// Règle : l'UI ne parle jamais au SDK en direct — un seul tool
// `batch_execute` est exposé au modèle. Le schéma d'entrée est RÉUTILISÉ
// depuis le cœur (`tools-core/schemas`, même version que le MCP et le
// routeur T5) : aucune divergence possible, la version du seam est
// tamponnée pour traçabilité.

import { BatchExecuteInput } from "../../../pcb-mcp/src/tools-core/schemas";

/** Version du seam AgentChat (schémas + protocole de lot). */
export const AGENT_CHAT_SCHEMA_VERSION = 1;

/** Nom unique du tool exposé au modèle. */
export const BATCH_EXECUTE_TOOL_NAME = "batch_execute" as const;

/** Schéma d'entrée du tool (réutilisé du cœur : parité MCP/routeur). */
export const BatchExecuteToolInput = BatchExecuteInput;

export type BatchExecuteToolInput = typeof BatchExecuteInput._type;
