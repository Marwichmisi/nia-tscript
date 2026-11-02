// Compile partagée frontend (ticket #15, variante B validée au prototype).
// UNE seule compile core+eval en WebWorker blob-url bundlé (offline-first),
// partagée entre les 3 onglets Schéma/PCB/3D. Jamais de circuit-json inventé :
// en échec, retourne [] + bandeau RÉSEAU REQUIS explicite.
import { createCircuitWebWorker } from "@tscircuit/eval/worker";
import { runTscircuitCode } from "@tscircuit/eval";
import evalWebWorkerBlobUrl from "@tscircuit/eval/blob-url";
import { ENTRYPOINT, initialFsMap } from "./board";

export type CompileMode =
  | "worker-blob-local"
  | "worker-blob-local-nocdn"
  | "inline-maintenance"
  | "echec";

export interface CompileResult {
  circuitJson: unknown[];
  mode: CompileMode;
  banner: string | null;
}

export const CDN_BANNER =
  "CDN désactivé (disableCdnLoading) : toute pièce/empreinte non bundlée est indisponible hors-ligne.";

export async function compileBoard(
  log: (msg: string) => void,
  opts: { disableCdnLoading: boolean },
): Promise<CompileResult> {
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
      fsMap: initialFsMap(),
      mainComponentPath: ENTRYPOINT,
    } as never);
    await worker.renderUntilSettled();
    const circuitJson = (await worker.getCircuitJson()) as unknown[];
    try {
      await (worker as unknown as { kill: () => Promise<void> }).kill();
    } catch {
      /* best-effort */
    }
    log(`worker : ${circuitJson.length} éléments, 0 erreur`);
    return {
      circuitJson,
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
    const circuitJson = (await runTscircuitCode(initialFsMap(), {
      mainComponentPath: ENTRYPOINT,
    })) as unknown[];
    log(`inline : ${circuitJson.length} éléments`);
    return {
      circuitJson,
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
    mode: "echec",
    banner:
      "RÉSEAU REQUIS pour compiler (worker bundlé + CDN indisponibles). Aucun circuit-json — viewers vides, c'est le dégradé attendu.",
  };
}
