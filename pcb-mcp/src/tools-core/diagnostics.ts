// Cœur pur : types compile + extracteur de diagnostics embarqués (T1, #56).
// Extrait de `src/compile.ts` SANS changer la logique : même regex stricte
// sidecar (suffixe _error/_warning, la sous-chaîne nue ne compte pas).
// Aucun import node:, aucun moteur (le `CircuitRunner` reste injecté par
// l'hôte via `CompileFn`). La version frontend large n'est PAS unifiée ici
// (c'est T2).
import { emptyStats, type CircuitStats } from "./board.js";

export type CompileMode = "worker-blob-local" | "worker-blob-local-nocdn" | "echec";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}

export interface CompileResult {
  circuitJson: unknown[];
  diagnostics: Diagnostic[];
  stats: CircuitStats;
  mode: CompileMode;
  banner: string | null;
  errors: number;
  warnings: number;
}

/** Fonction de compile injectée par l'hôte (Bun `CircuitRunner` côté
 *  sidecar, WebWorker bundlé côté WebView). Même `CompileResult` des deux
 *  côtés, même extracteur (voir ci-dessous). */
export type CompileFn = (
  code: string,
  opts?: { disableCdnLoading?: boolean },
) => Promise<CompileResult>;

export const CDN_BANNER =
  "CDN désactivé (disableCdnLoading) : toute pièce/empreinte non bundlée est indisponible hors-ligne.";

export function compileFailure(message: string, bannerPrefix: string): CompileResult {
  return {
    circuitJson: [],
    diagnostics: [{ severity: "error", message, source: "compile" }],
    stats: emptyStats(),
    mode: "echec",
    banner: `${bannerPrefix} : ${message}`,
    errors: 1,
    warnings: 0,
  };
}

function firstNonEmptyString(el: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = el[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Diagnostics embarqués du circuit-json (#39, revue #37 item 1).
 * Signaux reconnus (indépendants de la version core exacte) :
 * - `type` exactement "error"/"warning" ou à suffixe "_error"/"_warning"
 *   (insensible à la casse ; la sous-chaîne nue — ex "error_report" —
 *   ne compte PAS, sinon faux positifs qui bloquent batch/export) ;
 * - champ explicite `error_message`/`error` (resp. `warning_message`/`warning`).
 * Priorité du libellé : champ explicite > `message` > extrait JSON.
 * Source "circuit-json" (distincte de "compile" et des domaines checks).
 */
export function extractEmbeddedDiagnostics(circuitJson: unknown[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of circuitJson ?? []) {
    const el = (raw ?? {}) as Record<string, unknown>;
    const type = typeof el["type"] === "string" ? (el["type"] as string) : "";
    const lowered = type.toLowerCase();
    const isErrorType = /(^|_)error$/.test(lowered);
    const isWarningType = /(^|_)warning$/.test(lowered);
    const errorField = firstNonEmptyString(el, ["error_message", "error"]);
    const warningField = firstNonEmptyString(el, ["warning_message", "warning"]);
    const messageField = firstNonEmptyString(el, ["message"]);
    if (isErrorType || errorField !== null) {
      out.push({
        severity: "error",
        message: errorField ?? messageField ?? JSON.stringify(raw).slice(0, 300),
        source: "circuit-json",
      });
    } else if (isWarningType || warningField !== null) {
      out.push({
        severity: "warning",
        message: warningField ?? messageField ?? JSON.stringify(raw).slice(0, 300),
        source: "circuit-json",
      });
    }
  }
  return out;
}

export function enrichNoChildrenHint(message: string): string {
  if (
    message.includes("IsolatedCircuit has no children") ||
    message.includes("RootCircuit has no children")
  ) {
    return (
      `${message}. "entrypoint" est positionné alors que le fichier exporte un ` +
      `composant : utilisez mainComponentPath SANS entrypoint ` +
      `(cf. note prototype commit 83ab848).`
    );
  }
  return message;
}
