// Worker de compilation (core + eval, offline-first) — ticket #12.
// Exécuté dans le sidecar Bun via CircuitRunner (même moteur que le WebWorker
// blob-url du prototype, sans fetch CDN au runtime).
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
  "CDN désactivé (disableCdnLoading) : toute pièce/empreinte non bundlée est indisponible hors-ligne.";

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
    return {
      circuitJson,
      diagnostics: [],
      stats,
      mode: disableCdnLoading ? "worker-blob-local-nocdn" : "worker-blob-local",
      banner: disableCdnLoading ? CDN_BANNER : null,
      errors: 0,
      warnings: 0,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return failResult(enrichNoChildrenHint(raw), "Échec compilation");
  }
}
