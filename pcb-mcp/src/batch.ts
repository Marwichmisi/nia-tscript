// Moteur batch atomique pur (sans I/O ni compile) — ticket #16.
// Applique une liste d'ops patch + live en mémoire, dans l'ordre.
// Premier échec → { ok:false, failedIndex, message }, sans effet de bord.
// Le rollback fichier+live et la recompile unique sont faits par l'appelant
// (mcp.ts) : snapshot avant, compile une fois après, restore si échec.
import { applyAnchoredPatch } from "./patch.js";
import {
  DEFAULT_ROUTE_EFFORT,
  isRouteEffort,
  ROUTE_EFFORTS,
  withLocalAutorouter,
  type RouteEffort,
} from "./board.js";
import {
  applyMove,
  applyReassignNet,
  applyRotate,
  applySwapPackage,
} from "./live.js";

export type BatchOp =
  | { kind: "patch"; anchor: string; replacement: string }
  | { kind: "move"; refdes: string; x: number; y: number }
  | { kind: "rotate"; refdes: string; degrees: number }
  | { kind: "swap_package"; refdes: string; footprint: string }
  | { kind: "reassign_net"; refdes: string; pin: string; net: string }
  | { kind: "route"; effort?: RouteEffort };

export type { RouteEffort };

export interface BatchOk {
  ok: true;
  code: string;
}

export interface BatchErr {
  ok: false;
  failedIndex: number;
  message: string;
}

export const BATCH_MAX_OPS = 20;

export function applyBatch(code: string, ops: BatchOp[]): BatchOk | BatchErr {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, failedIndex: 0, message: "lot vide : fournissez au moins une opération" };
  }
  if (ops.length > BATCH_MAX_OPS) {
    return {
      ok: false,
      failedIndex: BATCH_MAX_OPS,
      message: `lot trop grand (${ops.length} ops, max ${BATCH_MAX_OPS}) : découpez en plusieurs batch_execute`,
    };
  }
  let next = code;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    switch (op.kind) {
      case "patch": {
        const r = applyAnchoredPatch(next, op.anchor ?? "", op.replacement ?? "");
        if (!r.ok) return { ok: false, failedIndex: i, message: r.message };
        next = r.code;
        break;
      }
      case "move": {
        const r = applyMove(next, op.refdes ?? "", op.x, op.y);
        if (!r.ok) return { ok: false, failedIndex: i, message: r.message };
        next = r.code;
        break;
      }
      case "rotate": {
        const r = applyRotate(next, op.refdes ?? "", op.degrees);
        if (!r.ok) return { ok: false, failedIndex: i, message: r.message };
        next = r.code;
        break;
      }
      case "swap_package": {
        const r = applySwapPackage(next, op.refdes ?? "", op.footprint ?? "");
        if (!r.ok) return { ok: false, failedIndex: i, message: r.message };
        next = r.code;
        break;
      }
      case "reassign_net": {
        const r = applyReassignNet(next, op.refdes ?? "", op.pin ?? "", op.net ?? "");
        if (!r.ok) return { ok: false, failedIndex: i, message: r.message };
        next = r.code;
        break;
      }
      case "route": {
        const effort = (op as { effort?: unknown }).effort ?? DEFAULT_ROUTE_EFFORT;
        if (!isRouteEffort(effort)) {
          return {
            ok: false,
            failedIndex: i,
            message:
              `route : effort invalide "${String(effort)}" (attendu ${ROUTE_EFFORTS.map((e) => `"${e}"`).join(" | ")}, défaut "${DEFAULT_ROUTE_EFFORT}")`,
          };
        }
        const r = withLocalAutorouter(next, effort);
        if (!r.ok) return { ok: false, failedIndex: i, message: r.message };
        next = r.code;
        break;
      }
      default:
        return {
          ok: false,
          failedIndex: i,
          message: `op inconnue "${(op as { kind?: unknown }).kind}" (batch V1 : patch | move | rotate | swap_package | reassign_net | route)`,
        };
    }
  }
  return { ok: true, code: next };
}
