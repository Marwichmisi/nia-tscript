// Compile partagée frontend (ticket #15, variante B validée au prototype).
// UNE seule compile core+eval en WebWorker blob-url bundlé (offline-first),
// partagée entre les 3 onglets Schéma/PCB/3D. Jamais de circuit-json inventé :
// en échec, retourne [] + bandeau RÉSEAU REQUIS explicite.
//
// Stratégie CDN/offline unique (#39, alignée avec pcb-mcp/src/compile.ts) :
// offline-first — worker bundlé local, CDN autorisé par défaut ;
// `disableCdnLoading: true` = strict offline (bandeau explicite).
// Le repli inline (requiert réseau CDN) est réservé au frontend : il
// n'existe pas côté sidecar et reste affiché RÉSEAU REQUIS.
// Diagnostics (#39) : erreurs/warnings embarqués du circuit-json remontés
// (compteurs réels, jamais « 0 erreur » hardcodé), miroir de l'extracteur
// sidecar.
import { createCircuitWebWorker } from "@tscircuit/eval/worker";
import { runTscircuitCode } from "@tscircuit/eval";
import evalWebWorkerBlobUrl from "@tscircuit/eval/blob-url";
import { ENTRYPOINT, initialFsMap } from "./board";

export type CompileMode =
  | "worker-blob-local"
  | "worker-blob-local-nocdn"
  | "inline-maintenance"
  | "echec";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}

export interface CompileResult {
  circuitJson: unknown[];
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  mode: CompileMode;
  banner: string | null;
}

export const CDN_BANNER =
  "CDN désactivé (disableCdnLoading) : toute pièce/empreinte non bundlée est indisponible hors-ligne.";

/** Miroir frontend de l'extracteur sidecar (pcb-mcp/src/compile.ts, #39).
 *  T2 I9 (#59) : même regex stricte que le sidecar (suffixe _error/_warning,
 *  la sous-chaîne nue — ex `error_report` — ne compte pas). */
export function extractEmbeddedDiagnostics(circuitJson: unknown[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of circuitJson ?? []) {
    const el = (raw ?? {}) as Record<string, unknown>;
    const type = typeof el["type"] === "string" ? (el["type"] as string) : "";
    const lowered = type.toLowerCase();
    const str = (k: string): string | null => {
      const v = el[k];
      return typeof v === "string" && v.trim() ? v : null;
    };
    const errorField = str("error_message") ?? str("error");
    const warningField = str("warning_message") ?? str("warning");
    const messageField = str("message");
    if (/(^|_)error$/.test(lowered) || errorField !== null) {
      out.push({
        severity: "error",
        message: errorField ?? messageField ?? JSON.stringify(raw).slice(0, 300),
        source: "circuit-json",
      });
    } else if (/(^|_)warning$/.test(lowered) || warningField !== null) {
      out.push({
        severity: "warning",
        message: warningField ?? messageField ?? JSON.stringify(raw).slice(0, 300),
        source: "circuit-json",
      });
    }
  }
  return out;
}

function toCounts(diagnostics: Diagnostic[]): { errors: number; warnings: number } {
  return {
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
  };
}

export async function compileBoard(
  log: (msg: string) => void,
  opts: { disableCdnLoading: boolean; code?: string },
): Promise<CompileResult> {
  const fsMap = opts.code ? { [ENTRYPOINT]: opts.code } : initialFsMap();
  try {
    log(
      `worker : compile locale (blob-url bundlé, disableCdnLoading=${opts.disableCdnLoading})…`,
    );
    const worker = await createCircuitWebWorker({
      webWorkerBlobUrl: evalWebWorkerBlobUrl as string,
      disableCdnLoading: opts.disableCdnLoading || undefined,
      platform: { partsEngineDisabled: true },
    } as never);
    await worker.executeWithFsMap({
      fsMap,
      mainComponentPath: ENTRYPOINT,
    } as never);
    await worker.renderUntilSettled();
    const circuitJson = (await worker.getCircuitJson()) as unknown[];
    try {
      await (worker as unknown as { kill: () => Promise<void> }).kill();
    } catch {
      /* best-effort */
    }
    const diagnostics = extractEmbeddedDiagnostics(circuitJson);
    const { errors, warnings } = toCounts(diagnostics);
    log(`worker : ${circuitJson.length} éléments, ${errors} erreur(s), ${warnings} warning(s)`);
    return {
      circuitJson,
      diagnostics,
      errors,
      warnings,
      mode: opts.disableCdnLoading ? "worker-blob-local-nocdn" : "worker-blob-local",
      banner: opts.disableCdnLoading ? CDN_BANNER : null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`worker blob-url ÉCHEC : ${msg}`);
  }

  try {
    log("repli : compile inline (requiert réseau CDN)…");
    // NOTE ticket #24 : passer l'objet fsMap ENTIER, jamais la string seule —
    // runTscircuitCode(string) la rebaptise "user-code.tsx" en interne, ce qui
    // casse mainComponentPath ("File not found main.tsx"). L'objet préserve "main.tsx".
    const circuitJson = (await runTscircuitCode(fsMap, {
      mainComponentPath: ENTRYPOINT,
    })) as unknown[];
    const diagnostics = extractEmbeddedDiagnostics(circuitJson);
    const { errors, warnings } = toCounts(diagnostics);
    log(`inline : ${circuitJson.length} éléments, ${errors} erreur(s), ${warnings} warning(s)`);
    return {
      circuitJson,
      diagnostics,
      errors,
      warnings,
      mode: "inline-maintenance",
      banner:
        "RÉSEAU REQUIS pour compilation inline (imports CDN jscdn/cjs) — le bundling blob-url a échoué.",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`inline ÉCHEC : ${msg}`);
  }

  return {
    circuitJson: [],
    diagnostics: [],
    errors: 0,
    warnings: 0,
    mode: "echec",
    banner:
      "RÉSEAU REQUIS pour compiler (worker bundlé + CDN indisponibles). Aucun circuit-json — viewers vides, c'est le dégradé attendu.",
  };
}
