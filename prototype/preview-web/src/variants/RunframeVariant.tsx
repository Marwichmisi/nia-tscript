// PROTOTYPE jetable — ticket wayfinder #5. Variante A : runframe seul.
import { useRef } from "react"
import { RunFrame } from "@tscircuit/runframe/runner"
import evalWebWorkerBlobUrl from "@tscircuit/eval/blob-url"
import { ENTRYPOINT, FSMAP } from "../lib/board"
import { StatusPanel } from "../components/StatusPanel"
import type { ScreenshotKind } from "../lib/screenshot"

export function RunframeVariant(props: {
  circuitJson: any[]
  logs: string[]
  mode: string
  banner: string | null
  onCircuitJson: (cj: any[]) => void
  onLog: (msg: string) => void
}) {
  const viewRef = useRef<HTMLElement | null>(null)
  const kind: ScreenshotKind = "pcb_2d" // runframe gère ses onglets en interne ; contrat = vue active

  return (
    <div>
      <h2 style={{ fontFamily: "monospace" }}>
        PROTOTYPE Variante A — <code>@tscircuit/runframe</code> seul (RunFrame + worker blob bundlé)
      </h2>
      <div
        ref={viewRef as any}
        style={{ height: 480, border: "1px solid #333", marginBottom: 8 }}
      >
        <RunFrame
          fsMap={FSMAP as any}
          mainComponentPath={ENTRYPOINT}
          platformConfig={{ partsEngineDisabled: true } as any}
          evalWebWorkerBlobUrl={evalWebWorkerBlobUrl as unknown as string}
          defaultActiveTab="pcb"
          onCircuitJsonChange={(cj) => props.onCircuitJson(cj as any[])}
          onRenderEvent={(ev) => props.onLog(`runframe event: ${JSON.stringify(ev)?.slice(0, 200)}`)}
          onError={(e) => props.onLog(`runframe erreur: ${e?.message ?? String(e)}`)}
        />
      </div>
      <StatusPanel
        circuitJson={props.circuitJson}
        logs={props.logs}
        mode={props.mode}
        banner={props.banner}
        viewRef={viewRef}
        screenshotKind={kind}
      />
    </div>
  )
}
