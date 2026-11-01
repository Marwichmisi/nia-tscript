// PROTOTYPE jetable — ticket wayfinder #5.
// "Two variants on a single route, switchable via ?view= + floating bar."
// Variantes radicalement différentes : runframe monolithe (A) vs viewers séparés à onglets (B).
import { useCallback, useEffect, useState } from "react"
import { RunframeVariant } from "./variants/RunframeVariant"
import { ViewersVariant } from "./variants/ViewersVariant"
import { compileBoard, type CompileMode } from "./lib/compile"

type View = "runframe" | "viewers"

function getView(): View {
  const v = new URLSearchParams(window.location.search).get("view")
  return v === "viewers" ? "viewers" : "runframe"
}

export default function App() {
  const [view, setView] = useState<View>(() => getView())
  const [circuitJson, setCircuitJson] = useState<any[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [mode, setMode] = useState<CompileMode | "compilation…">("compilation…")
  const [banner, setBanner] = useState<string | null>(null)
  const [disableCdn, setDisableCdn] = useState(false)
  const [nonce, setNonce] = useState(0)

  const log = useCallback(
    (msg: string) => setLogs((l) => [...l, `[${new Date().toISOString().slice(11, 19)}] ${msg}`]),
    [],
  )

  useEffect(() => {
    let alive = true
    setLogs([])
    setCircuitJson([])
    setBanner(null)
    setMode("compilation…")
    log("PROTOTYPE preview-web — compile core+eval en WebWorker, blob-url bundlé (offline-first)")
    compileBoard(log, { disableCdnLoading: disableCdn }).then((r) => {
      if (!alive) return
      setCircuitJson(r.circuitJson)
      setMode(r.mode)
      setBanner(r.banner)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disableCdn, nonce])

  function go(v: View) {
    const url = new URL(window.location.href)
    url.searchParams.set("view", v)
    window.history.replaceState(null, "", url)
    setView(v)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (e.key === "ArrowLeft") go(view === "runframe" ? "viewers" : "runframe")
      if (e.key === "ArrowRight") go(view === "runframe" ? "viewers" : "runframe")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div style={{ padding: 12, paddingBottom: 80 }}>
      <div style={{ background: "#fdd", border: "2px solid red", padding: 6, marginBottom: 8 }}>
        PROTOTYPE JETABLE (ticket #5) — ne pas merger dans main. Une seule route, switch par{" "}
        <code>?view=runframe|viewers</code>. Lancer : <code>npm install &amp;&amp; npm run dev</code>
      </div>
      <label style={{ fontFamily: "monospace", fontSize: 12 }}>
        <input type="checkbox" checked={disableCdn} onChange={(e) => setDisableCdn(e.target.checked)} />{" "}
        disableCdnLoading (simule offline strict — doit dégrader avec bandeau)
      </label>{" "}
      <button onClick={() => setNonce((n) => n + 1)} style={{ fontSize: 12 }}>
        ↻ recompiler
      </button>
      {view === "runframe" ? (
        <RunframeVariant
          circuitJson={circuitJson}
          logs={logs}
          mode={mode}
          banner={banner}
          onCircuitJson={setCircuitJson}
          onLog={log}
        />
      ) : (
        <ViewersVariant circuitJson={circuitJson} logs={logs} mode={mode} banner={banner} />
      )}
      {/* Barre flottante : ← / label / → , ←→ clavier, distincte du design évalué */}
      <div
        style={{
          position: "fixed",
          bottom: 12,
          left: "50%",
          transform: "translateX(-50%)",
          background: "#111",
          color: "#fff",
          borderRadius: 999,
          padding: "6px 12px",
          display: "flex",
          gap: 12,
          alignItems: "center",
          fontFamily: "monospace",
          boxShadow: "0 2px 12px rgba(0,0,0,.5)",
          zIndex: 9999,
        }}
      >
        <button onClick={() => go(view === "runframe" ? "viewers" : "runframe")} aria-label="précédent">
          ←
        </button>
        <span>
          {view === "runframe" ? "A (runframe seul)" : "B (viewers séparés)"} — ?view={view}
        </span>
        <button onClick={() => go(view === "runframe" ? "viewers" : "runframe")} aria-label="suivant">
          →
        </button>
      </div>
    </div>
  )
}
