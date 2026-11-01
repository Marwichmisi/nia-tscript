// PROTOTYPE jetable — ticket wayfinder #5. Variante B : viewers séparés bundlés.
import { useRef, useState } from "react"
import { SchematicViewer } from "@tscircuit/schematic-viewer"
import { PCBViewer } from "@tscircuit/pcb-viewer"
import { CadViewer } from "@tscircuit/3d-viewer"
import { StatusPanel } from "../components/StatusPanel"
import type { ScreenshotKind } from "../lib/screenshot"

type Tab = "schema" | "pcb" | "3d"

const KIND: Record<Tab, ScreenshotKind> = {
  schema: "schematique_2d",
  pcb: "pcb_2d",
  "3d": "pcb_3d",
}

export function ViewersVariant(props: {
  circuitJson: any[]
  logs: string[]
  mode: string
  banner: string | null
}) {
  const [tab, setTab] = useState<Tab>("schema")
  const viewRef = useRef<HTMLElement | null>(null)

  return (
    <div>
      <h2 style={{ fontFamily: "monospace" }}>
        PROTOTYPE Variante B — viewers séparés (schematic-viewer / pcb-viewer / 3d-viewer)
      </h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {(["schema", "pcb", "3d"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ fontWeight: tab === t ? "bold" : "normal" }}
          >
            {t === "schema" ? "Schéma" : t === "pcb" ? "PCB" : "3D"}
          </button>
        ))}
      </div>
      <div
        ref={viewRef as any}
        style={{ height: 480, border: "1px solid #333", marginBottom: 8 }}
      >
        {props.circuitJson.length === 0 ? (
          <div style={{ padding: 16, fontFamily: "monospace" }}>
            (pas de circuit-json — voir bandeau/logs ci-dessous)
          </div>
        ) : tab === "schema" ? (
          <SchematicViewer circuitJson={props.circuitJson as any} />
        ) : tab === "pcb" ? (
          <PCBViewer circuitJson={props.circuitJson as any} />
        ) : (
          <CadViewer circuitJson={props.circuitJson as any} />
        )}
      </div>
      <StatusPanel
        circuitJson={props.circuitJson}
        logs={props.logs}
        mode={props.mode}
        banner={props.banner}
        viewRef={viewRef}
        screenshotKind={KIND[tab]}
      />
    </div>
  )
}
