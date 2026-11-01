// PROTOTYPE jetable — ticket wayfinder #5. Surface d'état partagée (stats/logs/screenshot).
import { useRef, useState } from "react"
import { computeStats } from "../lib/board"
import { captureScreenshot, type ScreenshotKind } from "../lib/screenshot"

export function StatusPanel(props: {
  circuitJson: any[]
  logs: string[]
  mode: string
  banner: string | null
  viewRef: React.RefObject<HTMLElement | null>
  screenshotKind: ScreenshotKind
}) {
  const stats = computeStats(props.circuitJson)
  const [shot, setShot] = useState<null | {
    dataUrl: string
    bytes: number
    source: string
    w: number
    h: number
  }>(null)
  const [shotErr, setShotErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const kindLabel: Record<ScreenshotKind, string> = {
    schematique_2d: "schématique_2d",
    pcb_2d: "pcb_2d",
    pcb_3d: "pcb_3d",
  }

  async function onShot() {
    setShotErr(null)
    setShot(null)
    const el = props.viewRef.current
    if (!el) {
      setShotErr("vue non montée")
      return
    }
    setBusy(true)
    try {
      const r = await captureScreenshot(el, props.screenshotKind)
      setShot({ dataUrl: r.dataUrl, bytes: r.bytes, source: r.source, w: r.width, h: r.height })
    } catch (e: any) {
      setShotErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ border: "2px dashed #c00", padding: 8, fontFamily: "monospace", fontSize: 12 }}>
      <div style={{ fontWeight: "bold" }}>PROTOTYPE — état (mémoire seule, aucun test, aucun polish)</div>
      {props.banner && (
        <div style={{ background: "#fff3cd", border: "1px solid #c90", padding: 6, marginTop: 6 }}>
          ⚠️ {props.banner}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        mode compile : <b>{props.mode}</b> · éléments : <b>{stats.total}</b> · composants :{" "}
        <b>{stats.components}</b> · traces : <b>{stats.traces}</b> · nets : <b>{stats.nets}</b>
      </div>
      <details>
        <summary>détail par type ({Object.keys(stats.byType).length})</summary>
        <pre style={{ maxHeight: 120, overflow: "auto" }}>{JSON.stringify(stats.byType, null, 1)}</pre>
      </details>
      <details open>
        <summary>logs compile ({props.logs.length})</summary>
        <pre style={{ maxHeight: 120, overflow: "auto", background: "#111", color: "#0f0", padding: 6 }}>
          {props.logs.join("\n") || "(vide)"}
        </pre>
      </details>
      <div style={{ marginTop: 6 }}>
        <button onClick={onShot} disabled={busy}>
          {busy ? "capture…" : "📸 Screenshot agent"}
        </button>{" "}
        <span>
          contrat simulé : <b>{kindLabel[props.screenshotKind]}</b>
        </span>
        {shotErr && <span style={{ color: "red" }}> — échec : {shotErr}</span>}
        {shot && (
          <div style={{ marginTop: 6 }}>
            <div>
              PNG : {shot.w}×{shot.h} · base64 ≈ <b>{shot.bytes} octets</b> (source : {shot.source})
            </div>
            <img
              src={shot.dataUrl}
              alt="screenshot agent"
              style={{ maxWidth: 320, border: "1px solid #999", marginTop: 4 }}
            />
            <div>
              <a href={shot.dataUrl} download={`agent-${kindLabel[props.screenshotKind]}.png`}>
                ⬇ télécharger le PNG
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
