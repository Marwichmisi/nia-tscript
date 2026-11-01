// PROTOTYPE jetable — ticket wayfinder #5. Pas de persistance, tout en mémoire.
import { createCircuitWebWorker } from "@tscircuit/eval/worker"
import { runTscircuitCode } from "@tscircuit/eval"
import evalWebWorkerBlobUrl from "@tscircuit/eval/blob-url"
import { ENTRYPOINT, FSMAP } from "./board"

export type CompileMode =
  | "worker-blob-local"
  | "worker-blob-local-nocdn"
  | "inline-maintenance"
  | "echec"

export interface CompileResult {
  circuitJson: any[]
  mode: CompileMode
  banner: string | null // "réseau requis pour X" quand dégradé
}

export async function compileBoard(
  log: (msg: string) => void,
  opts: { disableCdnLoading: boolean },
): Promise<CompileResult> {
  // 1) Chemin nominal offline-first : worker avec blob-url bundlé localement
  try {
    log(
      `worker: createCircuitWebWorker(webWorkerBlobUrl=bundlé, disableCdnLoading=${opts.disableCdnLoading})`,
    )
    const worker = await createCircuitWebWorker({
      webWorkerBlobUrl: evalWebWorkerBlobUrl as string,
      disableCdnLoading: opts.disableCdnLoading || undefined,
      // PROTOTYPE : coupe le moteur pièces/fournisseurs (requêtes réseau longues,
      // ex "get-supplier-part-numbers 99%") pour que la compile finisse vite.
      // Question ouverte pour le verdict : pré-bundler quelles pièces offline ?
      platform: { partsEngineDisabled: true },
    } as any)
    await worker.executeWithFsMap({
      fsMap: FSMAP,
      mainComponentPath: ENTRYPOINT,
    } as any)
    log("worker: executeWithFsMap ok → renderUntilSettled…")
    await worker.renderUntilSettled()
    const circuitJson = (await worker.getCircuitJson()) as any[]
    log(`worker: getCircuitJson → ${circuitJson.length} éléments`)
    try {
      await worker.kill()
    } catch {
      /* prototype : ignore */
    }
    return {
      circuitJson,
      mode: opts.disableCdnLoading ? "worker-blob-local-nocdn" : "worker-blob-local",
      banner: opts.disableCdnLoading
        ? "CDN désactivé (disableCdnLoading) : toute pièce/empreinte non bundlée est indisponible hors-ligne."
        : null,
    }
  } catch (e: any) {
    log(`worker blob-url ÉCHEC : ${e?.message ?? String(e)}`)
  }

  // 2) Dégradation : compile inline main-thread (requiert réseau pour imports CDN)
  try {
    log("fallback: runTscircuitCode inline (main thread)…")
    const circuitJson = (await runTscircuitCode(FSMAP[ENTRYPOINT], {
      mainComponentPath: ENTRYPOINT,
    })) as any[]
    log(`inline: ${circuitJson.length} éléments`)
    return {
      circuitJson,
      mode: "inline-maintenance",
      banner:
        "RÉSEAU REQUIS pour compilation inline (imports CDN jscdn/cjs) — le bundling blob-url a échoué.",
    }
  } catch (e: any) {
    log(`inline ÉCHEC : ${e?.message ?? String(e)}`)
  }

  // 3) Échec propre : pas de JSON inventé (un faux circuit-json fausserait le verdict)
  return {
    circuitJson: [],
    mode: "echec",
    banner:
      "RÉSEAU REQUIS pour compiler (worker bundlé + CDN indisponibles). Aucun circuit-json — viewers vides, c'est le dégradé attendu.",
  }
}
