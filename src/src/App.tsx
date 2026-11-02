import { useCallback, useEffect, useRef, useState } from "react";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { PCBViewer } from "@tscircuit/pcb-viewer";
import { CadViewer } from "@tscircuit/3d-viewer";
import { invoke } from "@tauri-apps/api/core";
import { BOARD_CODE } from "./lib/board";
import { computeStats } from "./lib/board";
import { compileBoard, type CompileMode } from "./lib/compile";
import { captureScreenshot, type PreviewSource } from "./lib/screenshot";
import { ViewerErrorBoundary } from "./components/ErrorBoundary";

type Tab = "schema" | "pcb" | "3d";

const KIND: Record<Tab, PreviewSource> = {
  schema: "schematic_2d",
  pcb: "pcb_2d",
  "3d": "pcb_3d",
};

const TAB_LABEL: Record<Tab, string> = {
  schema: "Schéma",
  pcb: "PCB",
  "3d": "3D",
};

function initialTab(): Tab {
  const t = new URLSearchParams(window.location.search).get("tab");
  if (t === "pcb" || t === "3d" || t === "schema") return t;
  // Compat prototype : ?view=viewers → onglet schéma par défaut.
  return "schema";
}

interface Shot {
  dataUrl: string;
  bytes: number;
  backend: string;
  width: number;
  height: number;
  previewUrl: string | null;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => initialTab());
  const [circuitJson, setCircuitJson] = useState<unknown[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [mode, setMode] = useState<CompileMode | "compilation…">("compilation…");
  const [banner, setBanner] = useState<string | null>(null);
  const [disableCdn, setDisableCdn] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [boot, setBoot] = useState<string>("démarrage…");
  const [shot, setShot] = useState<Shot | null>(null);
  const [shotErr, setShotErr] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const viewRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback(
    (msg: string) =>
      setLogs((l) => [...l.slice(-49), `[${new Date().toISOString().slice(11, 19)}] ${msg}`]),
    [],
  );

  useEffect(() => {
    let alive = true;
    setLogs([]);
    setCircuitJson([]);
    setBanner(null);
    setMode("compilation…");
    setShot(null);
    setShotErr(null);
    log("compile partagée core+eval (worker blob-url bundlé, offline-first)…");
    compileBoard(log, { disableCdnLoading: disableCdn }).then((r) => {
      if (!alive) return;
      setCircuitJson(r.circuitJson);
      setMode(r.mode);
      setBanner(r.banner);
    });
    return () => {
      alive = false;
    };
  }, [disableCdn, nonce, log]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = (await invoke("get_boot_state")) as { ready: boolean; url: string; pid: number };
        if (alive) setBoot(s.ready ? `prêt — ${s.url} (pid ${s.pid})` : "démarrage…");
      } catch {
        if (alive) setBoot("hors Tauri (dev navigateur) — download seul");
      }
    })();
    const id = window.setInterval(async () => {
      try {
        const s = (await invoke("get_boot_state")) as { ready: boolean; url: string; pid: number };
        if (alive) setBoot(s.ready ? `prêt — ${s.url} (pid ${s.pid})` : "démarrage…");
      } catch {
        /* dev navigateur : ignore */
      }
    }, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const order: Tab[] = ["schema", "pcb", "3d"];
      const i = order.indexOf(tab);
      if (e.key === "ArrowRight") setTab(order[(i + 1) % order.length]!);
      if (e.key === "ArrowLeft") setTab(order[(i + order.length - 1) % order.length]!);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  }, [tab]);

  const stats = computeStats(circuitJson);
  const ready = mode === "worker-blob-local" || mode === "worker-blob-local-nocdn";

  async function onShot() {
    setShotErr(null);
    setShot(null);
    const el = viewRef.current;
    if (!el) {
      setShotErr("vue non montée");
      return;
    }
    setShotBusy(true);
    try {
      const r = await captureScreenshot(el, KIND[tab]);
      let previewUrl: string | null = null;
      try {
        const saved = (await invoke("save_screenshot", {
          source: r.source,
          dataUrl: r.dataUrl,
          width: r.width,
          height: r.height,
        })) as { previewUrl: string };
        previewUrl = saved.previewUrl;
      } catch {
        previewUrl = null; // hors Tauri : download seul, l'agent lira après ouverture de l'app
      }
      setShot({
        dataUrl: r.dataUrl,
        bytes: r.bytes,
        backend: r.backend,
        width: r.width,
        height: r.height,
        previewUrl,
      });
    } catch (e) {
      setShotErr(e instanceof Error ? e.message : String(e));
    } finally {
      setShotBusy(false);
    }
  }

  return (
    <div className="studio">
      <header className="studio-header">
        <div className="brand">
          <span className="brand-dot" aria-hidden />
          <div>
            <h1>NIATSCIRCUIT Studio</h1>
            <p className="subtitle">board nia-demo — R1/R2 + U1 · {boot}</p>
          </div>
        </div>
        <div className="header-badges">
          <span className={`pill ${ready ? "pill-ok" : mode === "compilation…" ? "pill-busy" : "pill-ko"}`}>
            {mode === "compilation…" ? "compilation…" : ready ? "prêt" : "dégradé"}
          </span>
          <span className="pill pill-mode">{mode}</span>
        </div>
      </header>

      {banner && (
        <div className={`banner ${mode === "echec" ? "banner-error" : "banner-warn"}`} role="status">
          <span aria-hidden>⚠️</span> {banner}
        </div>
      )}

      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Viewers">
          {(["schema", "pcb", "3d"] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`tab ${tab === t ? "tab-active" : ""}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <label className="offline-check" title="Simule le mode strictement offline">
            <input
              type="checkbox"
              checked={disableCdn}
              onChange={(e) => setDisableCdn(e.target.checked)}
            />
            offline strict
          </label>
          <button className="btn btn-ghost" onClick={() => setNonce((n) => n + 1)}>
            ↻ recompiler
          </button>
          <button className="btn btn-primary" onClick={onShot} disabled={shotBusy || circuitJson.length === 0}>
            {shotBusy ? "capture…" : "📸 Screenshot agent"}
          </button>
        </div>
      </div>

      <main className="layout">
        <section className="viewer-card">
          <div className="viewer-card-head">
            <span>
              {TAB_LABEL[tab]} · contrat <code>{KIND[tab]}</code>
            </span>
            <span className="viewer-count">{stats.total} éléments</span>
          </div>
          <div ref={viewRef} className="viewer-body">
            {circuitJson.length === 0 ? (
              <div className="viewer-empty">
                {mode === "compilation…" ? "Compilation partagée en cours…" : "Pas de circuit-json — voir bandeau/logs ci-dessous."}
              </div>
            ) : (
              <ViewerErrorBoundary tabName={tab}>
                {tab === "schema" ? (
                  <SchematicViewer circuitJson={circuitJson as never} />
                ) : tab === "pcb" ? (
                  <PCBViewer circuitJson={circuitJson as never} />
                ) : (
                  <CadViewer circuitJson={circuitJson as never} />
                )}
              </ViewerErrorBoundary>
            )}
          </div>
        </section>

        <aside className="side">
          <section className="card">
            <h2>État</h2>
            <dl className="stats">
              <div><dt>composants</dt><dd>{stats.components}</dd></div>
              <div><dt>traces</dt><dd>{stats.traces}</dd></div>
              <div><dt>nets</dt><dd>{stats.nets}</dd></div>
              <div><dt>total</dt><dd>{stats.total}</dd></div>
            </dl>
            <details className="logs">
              <summary>logs compile ({logs.length})</summary>
              <pre>{logs.join("\n") || "(vide)"}</pre>
            </details>
            <details>
              <summary>TSX source (lecture)</summary>
              <pre className="tsx">{BOARD_CODE}</pre>
            </details>
          </section>

          <section className="card">
            <h2>Screenshot agent</h2>
            {shotErr && <p className="shot-error">Échec : {shotErr}</p>}
            {shot ? (
              <div className="shot">
                <p>
                  PNG {shot.width}×{shot.height} · base64 ≈ <strong>{shot.bytes} octets</strong>
                  <br />
                  <span className="muted">moteur : {shot.backend} · source : {KIND[tab]}</span>
                  {shot.previewUrl && (
                    <>
                      <br />
                      <span className="muted">lien preview locale : </span>
                      <code className="preview-url">{shot.previewUrl}</code>
                    </>
                  )}
                  {!shot.previewUrl && (
                    <>
                      <br />
                      <span className="muted">hors Tauri : download seul (ouvre l&apos;app pour l&apos;agent).</span>
                    </>
                  )}
                </p>
                <img src={shot.dataUrl} alt={`screenshot ${KIND[tab]}`} className="shot-img" />
                <a href={shot.dataUrl} download={`agent-${KIND[tab]}.png`} className="btn btn-ghost">
                  ⬇ télécharger le PNG
                </a>
              </div>
            ) : (
              <p className="muted">
                Capture l&apos;onglet courant pour l&apos;agent (PNG base64 + taille + lien preview
                locale <code>file://</code>).
              </p>
            )}
          </section>

          <p className="fallback-note">
            Sans GPU (WebGPU rendering failed constaté au prototype), les vues PCB/3D basculent sur
            fallback SVG/canvas 2D documenté — jamais d&apos;image inventée.
          </p>
        </aside>
      </main>
    </div>
  );
}
