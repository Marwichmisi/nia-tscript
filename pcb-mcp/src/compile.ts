// Worker de compilation (core + eval, offline-first) — ticket #12.
// Hôte sidecar Bun (T1, #56) : `compileTsx` via CircuitRunner. Le pur
// (types, extracteur strict, failure factory) vit dans tools-core/ et est
// réexporté ici pour compatibilité ; la `CompileFn` est injectée aux outils
// du cœur via `ToolsDeps` (même `CompileResult` côté WebView).
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
import { computeStats, ENTRYPOINT } from "./tools-core/board.js";
import {
  CDN_BANNER,
  compileFailure,
  enrichNoChildrenHint,
  extractEmbeddedDiagnostics,
  type CompileResult,
  type Diagnostic,
} from "./tools-core/diagnostics.js";

export type { CompileResult, Diagnostic };
export type { CompileMode } from "./tools-core/diagnostics.js";
export { extractEmbeddedDiagnostics };

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
    return compileFailure(message, "RÉSEAU REQUIS pour compiler (moteur tscircuit indisponible)");
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
    return compileFailure(enrichNoChildrenHint(raw), "Échec compilation");
  }
}
