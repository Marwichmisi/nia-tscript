// UN tool exposé au modèle : `batch_execute` (1 approval = 1 lot).
//
// - Mode Manuel (défaut) : l'`execute` suspend jusqu'à `approve()` /
//   `reject()` de l'UI. Mode Auto : exécution immédiate.
// - Suppression du Projet toujours manuelle : par construction, `BatchOp`
//   ne contient AUCUNE opération de suppression (patch/move/rotate/
//   swap_package/reassign_net/route) ; toute espèce inconnue est refusée.
// - Rollback visible : le routeur T5 restaure le snapshot en échec ; la
//   sortie expose `applied/rolledBack/message` au modèle comme à l'UI.
// - Lectures libres : hors tool — la session injecte l'état carte dans les
//   instructions (opérations internes invisibles).

import { tool } from "ai";
import { BATCH_EXECUTE_TOOL_NAME, BatchExecuteToolInput } from "./schemas";
import type { ApprovalMode } from "./store";

export interface BatchExecutionOutcome {
  applied: boolean;
  rolledBack: boolean;
  errors: number;
  message: string;
  code: string | null;
}

/** Exécuteur injecté (prod : routeur T5 ; tests : double). */
export type BatchExecutor = (input: {
  operations: unknown[];
  sessionId?: string;
}) => Promise<BatchExecutionOutcome>;

export interface PendingApproval {
  toolCallId: string;
  operations: unknown[];
  decided: boolean;
}

/** Porte d'approbation (1 approval = 1 lot, décisions UI). */
export interface ApprovalGate {
  waitForApproval(toolCallId: string, operations: unknown[], signal?: AbortSignal): Promise<boolean>;
  approve(toolCallId: string): void;
  reject(toolCallId: string, reason?: string): void;
  list(): PendingApproval[];
}

export function createApprovalGate(): ApprovalGate {
  const waiting = new Map<
    string,
    { resolve: (ok: boolean) => void; operations: unknown[]; decided: boolean; onAbort?: () => void }
  >();

  return {
    waitForApproval(toolCallId, operations, signal) {
      if (signal?.aborted) {
        const e = new Error("approbation interrompue (Stop)");
        e.name = "AbortError";
        return Promise.reject(e);
      }
      return new Promise<boolean>((resolve, reject) => {
        if (waiting.has(toolCallId)) {
          resolve(false);
          return;
        }
        const onAbort = () => {
          waiting.delete(toolCallId);
          const e = new Error("approbation interrompue (Stop)");
          e.name = "AbortError";
          reject(e);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.set(toolCallId, {
          resolve: (ok) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(ok);
          },
          operations,
          decided: false,
          onAbort,
        });
      });
    },
    approve(toolCallId) {
      const w = waiting.get(toolCallId);
      if (!w || w.decided) return;
      w.decided = true;
      waiting.delete(toolCallId);
      w.resolve(true);
    },
    reject(toolCallId, _reason) {
      const w = waiting.get(toolCallId);
      if (!w || w.decided) return;
      w.decided = true;
      waiting.delete(toolCallId);
      w.resolve(false);
    },
    list() {
      return [...waiting.entries()].map(([toolCallId, w]) => ({
        toolCallId,
        operations: w.operations,
        decided: w.decided,
      }));
    },
  };
}

const ALLOWED_KINDS = new Set(["patch", "move", "rotate", "swap_package", "reassign_net", "route"]);

export interface BatchToolDeps {
  gate: ApprovalGate;
  execute: BatchExecutor;
  getMode: () => ApprovalMode;
}

/** Le tool SDK (schéma Zod du cœur, validé côté SDK + revérifié ici). */
export function createBatchExecuteTool(deps: BatchToolDeps) {
  return tool({
    description:
      "Applique UN lot atomique d'opérations carte (patch/move/rotate/swap_package/reassign_net/route) en une seule compile avec rollback. 1 approval = 1 lot.",
    inputSchema: BatchExecuteToolInput,
    execute: async (input, options) => {
      const toolCallId = (options as { toolCallId?: string } | undefined)?.toolCallId ?? `batch-${Date.now()}`;
      const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const parsed = BatchExecuteToolInput.safeParse(input);
      if (!parsed.success) {
        return { applied: false, rolledBack: false, rejected: false, errors: 1, message: `lot invalide : ${parsed.error.message}`, code: null };
      }
      const operations = (parsed.data.operations ?? []) as { kind?: string }[];
      if (operations.length === 0) {
        return { applied: false, rolledBack: false, rejected: false, errors: 1, message: "lot vide : fournissez au moins une opération", code: null };
      }
      const unknown = operations.find((o) => !o || !ALLOWED_KINDS.has(o.kind ?? ""));
      if (unknown) {
        return { applied: false, rolledBack: false, rejected: false, errors: 1, message: `opération interdite (jamais de suppression Projet) : ${JSON.stringify(unknown).slice(0, 160)}`, code: null };
      }
      if (deps.getMode() === "manuel") {
        const ok = await deps.gate.waitForApproval(toolCallId, operations, signal);
        if (!ok) {
          return { applied: false, rolledBack: false, rejected: true, errors: 0, message: "lot refusé par l'utilisateur (aucune modification)", code: null };
        }
      }
      if (signal?.aborted) {
        const e = new Error("lot interrompu (Stop)");
        e.name = "AbortError";
        throw e;
      }
      const outcome = await deps.execute({ operations, sessionId: parsed.data.session_id });
      return { ...outcome, rejected: false };
    },
  });
}

export { BATCH_EXECUTE_TOOL_NAME };
