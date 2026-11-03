import { useCallback, useEffect, useRef, useState } from "react";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { PCBViewer } from "@tscircuit/pcb-viewer";
import { CadViewer } from "@tscircuit/3d-viewer";
import { invoke } from "@tauri-apps/api/core";
import {
  Camera,
  PanelBottom,
  RotateCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { BOARD_CODE } from "./lib/board";
import { computeStats } from "./lib/board";
import { compileBoard, type CompileMode } from "./lib/compile";
import { captureScreenshot, type PreviewSource } from "./lib/screenshot";
import { preloadManifold } from "./lib/manifold";
import { Home } from "./components/Home";
import {
  closeProject as closeProj,
  createProject as createProj,
  currentProject,
  deleteProject as deleteProj,
  forgetProject as forgetProj,
  listProjects,
  openProject as openProj,
  projectName,
  readProjectMain,
  type ProjectItem,
} from "./lib/projects";
import { ViewerErrorBoundary } from "./components/ErrorBoundary";
import { Terminal, type Shot, type TermTab } from "./components/Terminal";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Separator } from "./components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";

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

const TERM_TABS: TermTab[] = ["console", "state", "tsx", "shot"];

function initialTab(): Tab {
  const t = new URLSearchParams(window.location.search).get("tab");
  if (t === "pcb" || t === "3d" || t === "schema") return t;
  return "schema";
}

function initialTermTab(): TermTab {
  const t = new URLSearchParams(window.location.search).get("term");
  if (t && (TERM_TABS as string[]).includes(t)) return t as TermTab;
  return "console";
}

function initialHeight(): number {
  const raw = window.localStorage.getItem("nia.term.height");
  if (raw === null) return 232;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 232;
  return Math.min(560, Math.max(120, Math.round(n)));
}

function initialCollapsed(): boolean {
  return window.localStorage.getItem("nia.term.collapsed") === "1";
}

/** Hauteur du conteneur viewer (ResizeObserver) pour le PCBViewer,
 *  qui ne mesure que sa largeur seul (prop height, défaut 600). */
function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(Math.round(el.getBoundingClientRect().height));
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setH(Math.round(rect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

/** Feedback « Copié » après clipboard (TSX, pont MCP…) : un hook par bouton,
 *  le timer est nettoyé au démontage. Remplace la duplication onCopyTsx /
 *  onCopyBridge (même writeText + timeout 1600 ms). */
function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);
  function copy(text: string) {
    if (!text) return;
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => setCopied(false));
  }
  return { copied, copy };
}

/** Rendu PCB adaptatif 0.1.3 (sans dette) : WebGPU si dispo, sinon canvas 2D upstream.
 *  WebKitGTK Linux n'a pas `navigator.gpu` même avec GPU physique. */
function initialPcbRenderer(): "webgpu" | "canvas" {
  try {
    const stored = window.localStorage.getItem("pcb_viewer_rendering_engine");
    if (stored && JSON.parse(stored) === "canvas") return "canvas";
    if (stored && JSON.parse(stored) === "webgpu") {
      if (typeof navigator !== "undefined" && (navigator as unknown as { gpu?: unknown }).gpu) {
        return "webgpu";
      }
      return "canvas";
    }
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && (navigator as unknown as { gpu?: unknown }).gpu) {
    return "webgpu";
  }
  return "canvas";
}

export default function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectCode, setProjectCode] = useState<string>(BOARD_CODE);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [projBusy, setProjBusy] = useState(false);
  const [projError, setProjError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => initialTab());
  const [termTab, setTermTab] = useState<TermTab>(() => initialTermTab());
  const [termCollapsed, setTermCollapsed] = useState<boolean>(() => initialCollapsed());
  const [termHeight, setTermHeight] = useState<number>(() => initialHeight());
  const [circuitJson, setCircuitJson] = useState<unknown[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [mode, setMode] = useState<CompileMode | "compilation…">("compilation…");
  const [banner, setBanner] = useState<string | null>(null);
  const [disableCdn, setDisableCdn] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [boot, setBoot] = useState<string>("démarrage…");
  const [bridge, setBridge] = useState<string>("");
  const [shot, setShot] = useState<Shot | null>(null);
  const [shotErr, setShotErr] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const [pcbRenderer, setPcbRenderer] = useState<"webgpu" | "canvas">(() => initialPcbRenderer());
  const tsxCopy = useCopyFeedback();
  const bridgeCopy = useCopyFeedback();
  const viewRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback(
    (msg: string) =>
      setLogs((l) => [...l.slice(-99), `[${new Date().toISOString().slice(11, 19)}] ${msg}`]),
    [],
  );

  const refreshProjects = useCallback(async () => {
    try {
      const cur = await currentProject().catch(() => null);
      setProjectPath(cur);
      const list = await listProjects().catch(() => ({ projects: [], lastOpened: null }));
      setProjects(list.projects);
      setLastOpened(list.lastOpened);
      if (cur) {
        try {
          const main = await readProjectMain(cur);
          setProjectCode(main.code);
        } catch {
          setProjectCode(BOARD_CODE);
        }
      }
    } catch (e) {
      setProjError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  // Manifold local pré-chargé une fois (offline-first, évite l'import jsdelivr).
  useEffect(() => {
    let alive = true;
    void preloadManifold()
      .then(() => {
        if (alive) log("manifold local pré-chargé (offline-first)");
      })
      .catch((e: unknown) => {
        if (alive) log(`manifold local ÉCHEC : ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      alive = false;
    };
  }, [log]);

  useEffect(() => {
    try {
      window.localStorage.setItem("pcb_viewer_rendering_engine", JSON.stringify(pcbRenderer));
    } catch {
      /* ignore */
    }
  }, [pcbRenderer]);

  async function withProjBusy<T>(fn: () => Promise<T>, withError = true): Promise<T | void> {
    setProjBusy(true);
    if (withError) setProjError(null);
    try {
      return await fn();
    } catch (e) {
      if (withError) setProjError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjBusy(false);
    }
  }

  async function handleOpen(p: string) {
    await withProjBusy(async () => {
      const opened = await openProj(p);
      setProjectPath(opened);
      const main = await readProjectMain(opened);
      setProjectCode(main.code);
      await refreshProjects();
    });
  }

  async function handleCreate(p: string, template: "vide" | "demo") {
    await withProjBusy(async () => {
      const created = await createProj(p, template);
      setProjectPath(created);
      const main = await readProjectMain(created);
      setProjectCode(main.code);
      await refreshProjects();
    });
  }

  async function handleClose() {
    await withProjBusy(async () => {
      await closeProj();
      setProjectPath(null);
      await refreshProjects();
    }, false);
  }

  async function handleForget(p: string) {
    await withProjBusy(async () => {
      await forgetProj(p);
      await refreshProjects();
    });
  }

  async function handleDelete(p: string) {
    if (!window.confirm(`Supprimer le dossier projet ?\n${p}`)) return;
    await withProjBusy(async () => {
      await deleteProj(p);
      const cur = await currentProject().catch(() => null);
      setProjectPath(cur);
      await refreshProjects();
    });
  }

  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    setLogs([]);
    setCircuitJson([]);
    setBanner(null);
    setMode("compilation…");
    setShot(null);
    setShotErr(null);
    log("compile partagée core+eval (worker blob-url bundlé, offline-first)…");
    compileBoard(log, { disableCdnLoading: disableCdn, code: projectCode }).then((r) => {
      if (!alive) return;
      setCircuitJson(r.circuitJson);
      setMode(r.mode);
      setBanner(r.banner);
    });
    return () => {
      alive = false;
    };
  }, [disableCdn, nonce, log, projectPath, projectCode]);

  useEffect(() => {
    let alive = true;
    const fetchBoot = async () => {
      try {
        const s = (await invoke("get_boot_state")) as {
          ready: boolean;
          url: string;
          pid: number;
          bridge_path?: string;
        };
        setBridge(s.bridge_path ?? "");
        if (alive) setBoot(s.ready ? `prêt — ${s.url} (pid ${s.pid})` : "démarrage…");
      } catch {
        if (alive) setBoot("hors Tauri (dev navigateur) — download seul");
      }
    };
    void fetchBoot();
    const id = window.setInterval(fetchBoot, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    url.searchParams.set("term", termTab);
    window.history.replaceState(null, "", url);
  }, [tab, termTab]);

  useEffect(() => {
    window.localStorage.setItem("nia.term.height", String(termHeight));
  }, [termHeight]);

  useEffect(() => {
    window.localStorage.setItem("nia.term.collapsed", termCollapsed ? "1" : "0");
  }, [termCollapsed]);

  const stats = computeStats(circuitJson);
  const ready = mode === "worker-blob-local" || mode === "worker-blob-local-nocdn";
  const compiling = mode === "compilation…";
  const viewerHeight = useElementHeight(viewRef);

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
      setTermTab("shot");
      setTermCollapsed(false);
    } catch (e) {
      setShotErr(e instanceof Error ? e.message : String(e));
      setTermTab("shot");
      setTermCollapsed(false);
    } finally {
      setShotBusy(false);
    }
  }

  if (!projectPath) {
    return (
      <div className="app">
        <Home
          projects={projects}
          lastOpened={lastOpened}
          busy={projBusy}
          error={projError}
          onOpen={handleOpen}
          onCreate={handleCreate}
          onForget={handleForget}
          onDelete={handleDelete}
          bridge={bridge}
          boot={boot}
          bridgeCopied={bridgeCopy.copied}
          onCopyBridge={() => bridgeCopy.copy(bridge ? `node "${bridge}"` : "")}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <a href="#viewer" className="skip-link">
        Aller au visualiseur
      </a>

      <header className="topbar">
        <div className="brand">
          <span className="brand-tile" aria-hidden="true">
            <img src="/logo.png" alt="" width={16} height={16} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          </span>
          <div className="brand-text">
            <h1 translate="no">NIATSCIRCUIT Studio</h1>
            <p className="brand-sub" title={projectPath}>
              <span translate="no">{projectName(projectPath)}</span> — {projectPath}
            </p>
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="viewer-tabs"
        >
          <TabsList aria-label="Viewers">
            {(["schema", "pcb", "3d"] as Tab[]).map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="topbar-actions">
          <span aria-live="polite" className="status-live">
            <Badge variant={ready ? "success" : compiling ? "warning" : "destructive"}>
              {compiling ? "Compilation…" : ready ? "Prêt" : "Dégradé"}
            </Badge>
            <Badge variant="outline" translate="no">
              {mode}
            </Badge>
          </span>
          <Separator orientation="vertical" />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="offline-wrap">
                  <input
                    id="offline-strict"
                    type="checkbox"
                    checked={disableCdn}
                    onChange={(e) => setDisableCdn(e.target.checked)}
                  />
                  <label htmlFor="offline-strict">
                    <WifiOff size={13} aria-hidden="true" />
                    Offline
                  </label>
                </span>
              </TooltipTrigger>
              <TooltipContent>Simule le mode strictement offline</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setNonce((n) => n + 1)}
                  aria-label="Recompiler la carte"
                >
                  <RotateCw size={15} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Recompiler</TooltipContent>
            </Tooltip>
            <Button
              variant="default"
              size="sm"
              onClick={onShot}
              disabled={shotBusy || circuitJson.length === 0}
            >
              <Camera size={14} aria-hidden="true" />
              {shotBusy ? "Capture…" : "Screenshot"}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setTermCollapsed(!termCollapsed)}
                  aria-label={termCollapsed ? "Déplier le terminal" : "Replier le terminal"}
                  aria-expanded={!termCollapsed}
                >
                  <PanelBottom size={15} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Terminal</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={handleClose} disabled={projBusy}>
              Fermer
            </Button>
          </TooltipProvider>
        </div>
      </header>

      {banner && (
        <div
          className={`notice ${mode === "echec" ? "notice-error" : "notice-warn"}`}
          role="status"
        >
          {mode === "echec" ? (
            <TriangleAlert size={13} aria-hidden="true" />
          ) : (
            <WifiOff size={13} aria-hidden="true" />
          )}
          <span>{banner}</span>
        </div>
      )}

      <main id="viewer" className="viewer-main" aria-label={`Visualiseur ${TAB_LABEL[tab]}`}>
        <div className="viewer-chips" aria-hidden="true">
          <span className="viewer-chip">
            {TAB_LABEL[tab]} · <code translate="no">{KIND[tab]}</code>
          </span>
          <span className="viewer-chip">{stats.total} éléments</span>
          {tab === "pcb" && (
            <button
              type="button"
              className="viewer-chip"
              title="Moteur PCB : canvas = sans GPU, webgpu = expérimental"
              onClick={() =>
                setPcbRenderer((r) => (r === "canvas" ? "webgpu" : "canvas"))
              }
              aria-hidden="false"
            >
              PCB: {pcbRenderer}
            </button>
          )}
        </div>
        <div ref={viewRef} className="viewer-body">
          {circuitJson.length === 0 ? (
            <div className="viewer-empty">
              {compiling
                ? "Compilation partagée en cours…"
                : "Pas de circuit-json — ouvre la Console du terminal pour le diagnostic."}
            </div>
          ) : (
            <ViewerErrorBoundary tabName={tab}>
                {tab === "schema" ? (
                  <SchematicViewer circuitJson={circuitJson as never} />
                ) : tab === "pcb" ? (
                  <PCBViewer
                    circuitJson={circuitJson as never}
                    height={viewerHeight > 0 ? viewerHeight : undefined}
                    renderer={pcbRenderer}
                  />
                ) : (
                <CadViewer circuitJson={circuitJson as never} />
              )}
            </ViewerErrorBoundary>
          )}
        </div>
      </main>

      <Terminal
        tab={termTab}
        onTabChange={setTermTab}
        collapsed={termCollapsed}
        onCollapsedChange={setTermCollapsed}
        height={termHeight}
        onHeightChange={setTermHeight}
        logs={logs}
        stats={stats}
        boot={boot}
        bridge={bridge}
        bridgeCopied={bridgeCopy.copied}
        onCopyBridge={() => bridgeCopy.copy(bridge ? `node "${bridge}"` : "")}
        modeLabel={mode}
        ready={ready}
        tsx={projectCode}
        copied={tsxCopy.copied}
        onCopyTsx={() => tsxCopy.copy(projectCode)}
        shot={shot}
        shotErr={shotErr}
        shotBusy={shotBusy}
        source={KIND[tab]}
        onShot={onShot}
      />
    </div>
  );
}
