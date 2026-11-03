// Worker de compilation (core + eval, offline-first) — ticket #12.
// Exécuté dans le sidecar Bun via CircuitRunner (même moteur que le WebWorker
// blob-url du prototype, sans fetch CDN au runtime).
//
// Stratégie CDN/offline unique (#39, alignée avec src/src/lib/compile.ts) :
// offline-first des deux côtés — worker bundlé local, CDN autorisé par
// défaut ; `disableCdnLoading: true` = strict offline (bandeau explicite) ;
// aucun repli réseau côté sidecar (le repli inline CDN est réservé au
// frontend et affiché RÉSEAU REQUIS).
//
// Diagnostics (#39) : les erreurs/warnings embarqués du circuit-json sont
// remontés (source "circuit-json") au lieu du « 0 erreur » hardcodé.
// Gate de placement inchangé (voir checks.ts).
//
// Note prototype respectée (commit 83ab848) : un entrypoint `export default`
// exige `mainComponentPath` SANS `entrypoint`, sinon
// « IsolatedCircuit has no children ». On ne passe donc JAMAIS `entrypoint`.
import { computeStats, emptyStats, ENTRYPOINT, type CircuitStats } from "./board.js";

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

const CDN_BANNER =
  "CDN désactivé (disableCdnLoading) : toute pièce/empreinte non bundlée est indisponible hors-ligne.";

function failResult(message: string, bannerPrefix: string): CompileResult {
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
 * Diagnostics embarqués du circuit-json (#39).
 * Signaux reconnus (indépendants de la version core exacte) :
 * - `type` contenant "error"/"warning" (insensible à la casse) ;
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
    const errorField = firstNonEmptyString(el, ["error_message", "error"]);
    const warningField = firstNonEmptyString(el, ["warning_message", "warning"]);
    const messageField = firstNonEmptyString(el, ["message"]);
    if (lowered.includes("error") || errorField !== null) {
      out.push({
        severity: "error",
        message: errorField ?? messageField ?? JSON.stringify(raw).slice(0, 300),
        source: "circuit-json",
      });
    } else if (lowered.includes("warning") || warningField !== null) {
      out.push({
        severity: "warning",
        message: warningField ?? messageField ?? JSON.stringify(raw).slice(0, 300),
        source: "circuit-json",
      });
    }
  }
  return out;
}

function enrichNoChildrenHint(message: string): string {
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

export async function compileTsx(
  code: string,
  opts?: { disableCdnLoading?: boolean },
): Promise<CompileResult> {
  const disableCdnLoading = opts?.disableCdnLoading ?? false;
  let CircuitRunnerCtor: new (config?: Record<string, unknown>) => {
    executeWithFsMap: (opts: Record<string, unknown>) => Promise<void>;
    renderUntilSettled: () => Promise<void>;
    getCircuitJson: () => Promise<unknown[]>;
  };
  try {
    const mod = (await import("@tscircuit/eval")) as Record<string, unknown>;
    CircuitRunnerCtor = mod["CircuitRunner"] as typeof CircuitRunnerCtor;
    if (!CircuitRunnerCtor) throw new Error("@tscircuit/eval sans export CircuitRunner");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return failResult(message, "RÉSEAU REQUIS pour compiler (moteur tscircuit indisponible)");
  }

  const runner = new CircuitRunnerCtor({
    platform: { partsEngineDisabled: true },
    disableCdnLoading: disableCdnLoading || undefined,
  } as Record<string, unknown>);

  try {
    // SANS `entrypoint` : voir note prototype ci-dessus.
    await runner.executeWithFsMap({
      fsMap: { [ENTRYPOINT]: code },
      mainComponentPath: ENTRYPOINT,
    });
    await runner.renderUntilSettled();
    const circuitJson = (await runner.getCircuitJson()) as unknown[];
    const stats = computeStats(circuitJson);
    // Compteurs réels (#39) : erreurs/warnings embarqués du circuit-json,
    // jamais « 0 » hardcodé.
    const diagnostics = extractEmbeddedDiagnostics(circuitJson);
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    const warnings = diagnostics.filter((d) => d.severity === "warning").length;
    return {
      circuitJson,
      diagnostics,
      stats,
      mode: disableCdnLoading ? "worker-blob-local-nocdn" : "worker-blob-local",
      banner: disableCdnLoading ? CDN_BANNER : null,
      errors,
      warnings,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return failResult(enrichNoChildrenHint(raw), "Échec compilation");
  }
}
