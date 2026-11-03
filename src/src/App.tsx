import { useCallback, useEffect, useRef, useState } from "react";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { PCBViewer } from "@tscircuit/pcb-viewer";
import { CadViewer } from "@tscircuit/3d-viewer";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  isMainOfProject,
  relinkProject as relinkProj,
  requestDeleteToken as requestDelToken,
  listProjects,
  openProject as openProj,
  projectName,
  readProjectMain,
  shortHash,
  writeProjectMain as writeProjMain,
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

/** Toast local (ticket #43, inspiration prototype jetable) : `role=status`,
 *  6 s, max 3. Réservé au resync temps réel (mise à jour agent, échec
 *  resync, déjà à jour) — le système complet vit au ticket #45. */
interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  msg: string;
}

const TOAST_TTL_MS = 6000;
const TOAST_MAX = 3;

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
  // Hash disque connu (relecture conditionnelle, ticket #43) : toute
  // resync compare l'événement `{ path, hash }` à cette valeur.
  const [knownHash, setKnownHash] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [reloading, setReloading] = useState(false);
  const knownHashRef = useRef<string | null>(null);
  const projectPathRef = useRef<string | null>(null);
  const toastSeq = useRef(0);
  const toastTimers = useRef<number[]>([]);
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
  const [boot, setBoot] = useState<string>("démarrage…");
  const [bridge, setBridge] = useState<string>("");
  const [shot, setShot] = useState<Shot | null>(null);
  const [shotErr, setShotErr] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const [shotName, setShotName] = useState("");
  const [manifoldStatus, setManifoldStatus] = useState<"loading" | "ready" | "error">("loading");
  const [manifoldError, setManifoldError] = useState<string | null>(null);
  /** Suppression avec garde backend (ticket #42) : le dialogue natif seul ne
   *  suffit plus — `pendingDelete` ouvre la confirmation, qui demande un
   *  jeton usage unique avant `delete_project`. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** Coller du TSX (ticket #45, Projet vide) : dialogue + zone de texte,
   *  pré-remplie du presse-papiers quand disponible. */
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  /** Compteur de compiles terminées : la frontière d'erreur repart saine à
   *  chaque nouveau circuit-json (ticket #45). */
  const [compileSeq, setCompileSeq] = useState(0);
  const [pcbRenderer, setPcbRenderer] = useState<"webgpu" | "canvas">(() => initialPcbRenderer());
  const tsxCopy = useCopyFeedback();
  const bridgeCopy = useCopyFeedback();
  const viewRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback(
    (msg: string) =>
      setLogs((l) => {
        // Anti-forgery (ticket #45) : les retours ligne embarqués (backend,
        // compile) ne doivent pas forger de fausses lignes de log.
        const clean = msg.replace(/[\r\n]+/g, " ⏎ ");
        return [...l.slice(-99), `[${new Date().toISOString().slice(11, 19)}] ${clean}`];
      }),
    [],
  );

  // Miroirs ref (handlers d'événements Tauri hors cycle render).
  useEffect(() => {
    knownHashRef.current = knownHash;
  }, [knownHash]);
  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  const pushToast = useCallback((kind: Toast["kind"], msg: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((t) => [...t.slice(-(TOAST_MAX - 1)), { id, kind, msg }]);
    const timer = window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, TOAST_TTL_MS);
    toastTimers.current.push(timer);
  }, []);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  /** Relit le disque et resynchronise si le hash a changé (`prevHash` = hash
   *  connu au moment du déclencheur, contre les rafales). Ne throw jamais :
   *  l'erreur part au bandeau + toast (jamais silencieuse). */
  const resyncFromDisk = useCallback(
    async (label: string, prevHash: string | null) => {
      const cur = projectPathRef.current;
      if (!cur) return;
      try {
        const main = await readProjectMain(cur);
        if (prevHash !== null && main.hash === prevHash) return; // déjà à jour
        setProjectCode(main.code);
        setKnownHash(main.hash);
        setReadError(null);
        pushToast("ok", `${label} — resync ✓ (hash ${shortHash(main.hash)})`);
        log(`${label} : resync disque (hash ${shortHash(main.hash)})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setReadError(msg);
        pushToast("error", `Échec resync : ${msg}`);
      }
    },
    [log, pushToast],
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
          setKnownHash(main.hash);
          setReadError(null);
        } catch (e) {
          // Jamais de Gabarit démo masquant (ticket #38, US5) : erreur visible.
          setProjectCode("");
          setKnownHash(null);
          setProjError(`lecture Projet impossible : ${e instanceof Error ? e.message : String(e)}`);
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
  // Gate la Review 3D : CadViewer monté seulement quand window.ManifoldModule prêt,
  // sinon la Review 3D part sur CDN et affiche le bandeau rouge.
  useEffect(() => {
    let alive = true;
    setManifoldStatus("loading");
    setManifoldError(null);
    void preloadManifold()
      .then(() => {
        if (alive) {
          setManifoldStatus("ready");
          log("manifold local pré-chargé (offline-first)");
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          const msg = e instanceof Error ? e.message : String(e);
          setManifoldStatus("error");
          setManifoldError(msg);
          log(`manifold local ÉCHEC : ${msg}`);
        }
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
      try {
        const main = await readProjectMain(opened);
        setProjectCode(main.code);
        setKnownHash(main.hash);
        setReadError(null);
      } catch (e) {
        // Jamais de Gabarit démo masquant : erreur visible, éditeur vide.
        setProjectCode("");
        setKnownHash(null);
        throw new Error(`Projet ouvert mais illisible : ${e instanceof Error ? e.message : String(e)}`);
      }
      await refreshProjects();
    });
  }

  async function handleCreate(p: string, template: "vide" | "demo") {
    await withProjBusy(async () => {
      const created = await createProj(p, template);
      setProjectPath(created);
      try {
        const main = await readProjectMain(created);
        setProjectCode(main.code);
        setKnownHash(main.hash);
        setReadError(null);
      } catch (e) {
        setProjectCode("");
        setKnownHash(null);
        throw new Error(`Projet créé mais illisible : ${e instanceof Error ? e.message : String(e)}`);
      }
      await refreshProjects();
    });
  }

  async function handleClose() {
    await withProjBusy(async () => {
      await closeProj();
      setProjectPath(null);
      setKnownHash(null);
      setReadError(null);
      await refreshProjects();
    }, false);
  }

  async function handleForget(p: string) {
    await withProjBusy(async () => {
      await forgetProj(p);
      await refreshProjects();
    });
  }

  async function handleRelink(oldPath: string, newPath: string) {
    await withProjBusy(async () => {
      const relinked = await relinkProj(oldPath, newPath);
      setProjectPath(relinked);
      try {
        const main = await readProjectMain(relinked);
        setProjectCode(main.code);
        setKnownHash(main.hash);
        setReadError(null);
      } catch (e) {
        setProjectCode("");
        setKnownHash(null);
        throw new Error(`Projet relié mais illisible : ${e instanceof Error ? e.message : String(e)}`);
      }
      await refreshProjects();
    });
  }

  async function handleDelete(p: string) {
    // Plus de window.confirm destructeur : la confirmation passe par le
    // dialogue dédié, qui exige le jeton backend (#42).
    setPendingDelete(p);
  }

  async function confirmDelete() {
    const p = pendingDelete;
    if (!p || projBusy) return;
    setPendingDelete(null);
    setProjBusy(true);
    setProjError(null);
    try {
      const token = await requestDelToken(p);
      await deleteProj(p, token);
      pushToast("ok", `Projet supprimé (confirmation backend) : ${projectName(p)}`);
      log(`suppression confirmée backend : ${p}`);
      const cur = await currentProject().catch(() => null);
      setProjectPath(cur);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProjError(msg);
      pushToast("error", `Suppression refusée : ${msg}`);
    } finally {
      setProjBusy(false);
    }
  }

  /** Colle du TSX dans le Projet vide (ticket #45, US6) : écriture atomique
   *  + hash relu, le watcher #43 resynchronise le reste. Garde anti-course :
   *  si l'agent a écrit entre-temps, on relit au lieu d'écraser. */
  async function openPasteDialog() {
    setPasteError(null);
    try {
      const t = await navigator.clipboard?.readText();
      setPasteText(typeof t === "string" ? t : "");
    } catch {
      setPasteText("");
    }
    setPasteOpen(true);
  }

  async function savePastedTsx() {
    if (!projectPath || pasteBusy) return;
    if (!pasteText.trim()) {
      setPasteError("Rien à enregistrer — colle du TSX d'abord.");
      return;
    }
    setPasteBusy(true);
    setPasteError(null);
    try {
      const fresh = await readProjectMain(projectPath);
      if (fresh.code.trim() !== "") {
        setProjectCode(fresh.code);
        setKnownHash(fresh.hash);
        throw new Error("le Projet n'est plus vide (écriture concurrente) — contenu relu, rien écrasé");
      }
      const saved = await writeProjMain(projectPath, pasteText);
      setProjectCode(saved.code);
      setKnownHash(saved.hash);
      setReadError(null);
      setPasteOpen(false);
      setPasteText("");
      pushToast("ok", `TSX collé ✓ (hash ${shortHash(saved.hash)})`);
      log(`TSX collé depuis le Studio (hash ${shortHash(saved.hash)})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPasteError(msg);
      pushToast("error", `Échec enregistrement : ${msg}`);
    } finally {
      setPasteBusy(false);
    }
  }

  /** Charge le gabarit démo dans le Projet vide (même source que le flux
   *  création : BOARD_CODE == DEMO_CODE backend). */
  async function handleLoadDemo() {
    if (!projectPath || projBusy) return;
    await withProjBusy(async () => {
      const fresh = await readProjectMain(projectPath);
      if (fresh.code.trim() !== "") {
        setProjectCode(fresh.code);
        setKnownHash(fresh.hash);
        pushToast("info", "Le Projet n'est plus vide — gabarit non chargé");
        return;
      }
      const saved = await writeProjMain(projectPath, BOARD_CODE);
      setProjectCode(saved.code);
      setKnownHash(saved.hash);
      setReadError(null);
      pushToast("ok", `Gabarit démo chargé ✓ (hash ${shortHash(saved.hash)})`);
      log(`gabarit démo chargé (hash ${shortHash(saved.hash)})`);
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
      // Nouveau circuit-json : la frontière d'erreur repart saine (#45).
      setCompileSeq((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [disableCdn, log, projectPath, projectCode]);

  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    let pollId: number | null = null;
    // Relecture conditionnelle : seul un hash différent relit le disque.
    const onMainChanged = (evt: { payload: { path: string; hash: string } }) => {
      if (!alive) return;
      const p = evt.payload;
      if (!p || typeof p.path !== "string" || typeof p.hash !== "string") return;
      if (!isMainOfProject(p.path, projectPathRef.current ?? "")) return;
      if (p.hash === knownHashRef.current) return; // déjà à jour
      void resyncFromDisk("MCP : main.tsx mis à jour", knownHashRef.current);
    };
    // Un seul watch côté backend (ré-armé ouverture/création, retiré
    // fermeture) ; la WebView se réabonne à chaque montage (cleanup).
    void listen<{ path: string; hash: string }>("project-main-changed", onMainChanged)
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // Repli dégradé uniquement (hors Tauri / dev navigateur) : polling
        // long à 15 s, même relecture conditionnelle par hash.
        if (!alive) return;
        pollId = window.setInterval(() => {
          const cur = projectPathRef.current;
          if (!cur || !alive) return;
          void readProjectMain(cur)
            .then((main) => {
              if (!alive) return;
              if (main.hash !== knownHashRef.current) {
                void resyncFromDisk("MCP : main.tsx mis à jour", knownHashRef.current);
              }
            })
            .catch(() => {
              /* le bandeau + toast du prochain succès/échec parleront */
            });
        }, 15000);
      });
    return () => {
      alive = false;
      if (unlisten) unlisten();
      if (pollId !== null) window.clearInterval(pollId);
    };
  }, [projectPath, resyncFromDisk]);

  /** Recompiler avec relecture disque d'abord (fini le snapshot périmé) :
   *  hash identique → toast « Déjà à jour », sinon compile le code relu.
   *  Désactivé pendant la compilation (fini le double-clic en boucle). */
  async function handleRecompile() {
    if (!projectPath || compiling || reloading) return;
    setReloading(true);
    try {
      const main = await readProjectMain(projectPath);
      if (main.hash === knownHashRef.current) {
        pushToast("info", `Déjà à jour (hash ${shortHash(main.hash)})`);
        return;
      }
      setProjectCode(main.code);
      setKnownHash(main.hash);
      setReadError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setReadError(msg);
      pushToast("error", `Échec resync : ${msg}`);
    } finally {
      setReloading(false);
    }
  }

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
  /** Projet vide explicite (ticket #45, US6) : ni erreur de lecture, ni
   *  échec de compile — juste 0 composant. À ne plus confondre avec un
   *  échec de compilation (mode `echec` + bandeau d'erreur). */
  const isEmptyProject =
    !compiling && !readError && mode !== "echec" && circuitJson.length === 0;
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
          name: shotName.trim() ? shotName.trim() : null,
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
      pushToast("ok", `Capture ${KIND[tab]} ✓ — ${r.bytes} octets${previewUrl ? " (preview locale)" : " (download seul)"}`);
      log(`capture ${r.source} (${r.bytes} o)${previewUrl ? " + preview locale" : ""}`);
      setTermTab("shot");
      setTermCollapsed(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setShotErr(msg);
      pushToast("error", `Échec capture : ${msg}`);
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
          onRelink={handleRelink}
          onDelete={handleDelete}
          bridge={bridge}
          boot={boot}
          bridgeCopied={bridgeCopy.copied}
          onCopyBridge={() => bridgeCopy.copy(bridge ? `node "${bridge}"` : "")}
        />
        {pendingDelete && (
          <div
            className="modal-backdrop"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setPendingDelete(null);
              }
            }}
          >
            <div
              className="modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="del-title"
              aria-describedby="del-desc"
            >
              <h2 id="del-title">Supprimer le dossier projet ?</h2>
              <p id="del-desc">
                <code translate="no">{pendingDelete}</code>
                <br />
                Cette action supprime DÉFINITIVEMENT le dossier (pas de
                corbeille en V1). La suppression exige une confirmation
                backend à jeton unique — l'oubli, lui, ne touche jamais au
                disque.
              </p>
              <div className="modal-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingDelete(null)}
                  autoFocus
                >
                  Annuler
                </Button>
                <Button
                  size="sm"
                  onClick={() => void confirmDelete()}
                  disabled={projBusy}
                >
                  Supprimer définitivement
                </Button>
              </div>
            </div>
          </div>
        )}
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
                  onClick={() => void handleRecompile()}
                  disabled={compiling || reloading}
                  aria-label={reloading ? "Relecture du disque en cours" : "Recompiler la carte (relecture disque d'abord)"}
                >
                  <RotateCw size={15} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {reloading ? "Relecture disque…" : "Recompiler (relecture disque d'abord)"}
              </TooltipContent>
            </Tooltip>
            <Button
              variant="default"
              size="sm"
              onClick={onShot}
              disabled={shotBusy || compiling || circuitJson.length === 0}
              title={
                compiling
                  ? "Désactivé pendant la compilation (l'image serait obsolète)"
                  : "Capturer l'onglet courant pour l'agent"
              }
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

      {/* Bandeau 4 états (ticket #43, d'après prototype jetable) :
          vert Prêt / ambre Compilation / rouge Erreur lecture + Réessayer /
          gris Accueil (= vue Home, sans Projet ouvert). */}
      {readError ? (
        <div className="notice notice-error" role="alert">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>Erreur lecture main.tsx : {readError}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void resyncFromDisk("Relecture manuelle", knownHashRef.current)}
          >
            Réessayer
          </Button>
        </div>
      ) : compiling ? (
        <div className="notice notice-warn" role="status">
          <WifiOff size={13} aria-hidden="true" />
          <span>Compilation… (relecture disque → worker)</span>
        </div>
      ) : (
        <div className="notice notice-ok" role="status">
          <span className="notice-dot" aria-hidden="true">
            ●
          </span>
          <span>
            Prêt — Projet ouvert : {projectPath ? projectName(projectPath) : ""} (
            {projectPath})
          </span>
        </div>
      )}

      {banner && !readError && !compiling && (
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

      <main id="viewer" className="viewer-main" aria-label={`Visualiseur ${TAB_LABEL[tab]}`} aria-busy={compiling}>
        {/* Pastilles décoratives masquées (l'onglet est déjà annoncé par
            aria-label) ; le bouton moteur reste exposé au clavier/lecteur
            d'écran (revue #37 item 8 : pas de focusable sous aria-hidden). */}
        <div className="viewer-chips">
          <span className="viewer-chip" aria-hidden="true">
            {TAB_LABEL[tab]} · <code translate="no">{KIND[tab]}</code>
          </span>
          <span className="viewer-chip" aria-hidden="true">{stats.total} éléments</span>
          {tab === "pcb" && (
            <button
              type="button"
              className="viewer-chip"
              title="Moteur PCB : canvas = sans GPU, webgpu = expérimental"
              aria-label={`Moteur de rendu PCB : ${pcbRenderer} — activer pour basculer`}
              onClick={() =>
                setPcbRenderer((r) => (r === "canvas" ? "webgpu" : "canvas"))
              }
            >
              PCB: {pcbRenderer}
            </button>
          )}
        </div>
        <div ref={viewRef} className="viewer-body">
          {isEmptyProject ? (
            <div className="viewer-empty-project" role="status">
              <div className="viewer-empty-title">
                Projet vide — board 20×20 mm, 0 composant.
              </div>
              <p className="term-muted">
                {projectCode.trim() === ""
                  ? "Le main.tsx est vide : ce n'est pas une erreur de compilation."
                  : "Le circuit ne contient aucun composant : ce n'est pas une erreur de compilation."}{" "}
                Charge le gabarit démo ou colle ton TSX pour commencer.
              </p>
              <div className="viewer-empty-actions">
                <Button size="sm" onClick={() => void handleLoadDemo()} disabled={projBusy}>
                  Charger le gabarit démo
                </Button>
                <Button size="sm" variant="outline" onClick={() => void openPasteDialog()}>
                  Coller du TSX…
                </Button>
              </div>
            </div>
          ) : circuitJson.length === 0 ? (
            <div className="viewer-empty">
              {compiling
                ? "Compilation partagée en cours…"
                : "Pas de circuit-json — ouvre la Console du terminal pour le diagnostic."}
            </div>
          ) : (
            <ViewerErrorBoundary tabName={tab} resetKey={`${tab}:${compileSeq}`}>
                {tab === "schema" ? (
                  <SchematicViewer circuitJson={circuitJson as never} />
                ) : tab === "pcb" ? (
                  <PCBViewer
                    circuitJson={circuitJson as never}
                    height={viewerHeight > 0 ? viewerHeight : undefined}
                    renderer={pcbRenderer}
                  />
                ) : manifoldStatus === "ready" ? (
                <CadViewer key="manifold-ready" circuitJson={circuitJson as never} />
                ) : manifoldStatus === "error" ? (
                  <div className="viewer-fallback" role="alert">
                    <div className="viewer-fallback-title">Review 3D indisponible (Manifold local)</div>
                    <p>
                      Le module géométrie n'a pas chargé en local. Vérifie l'onglet Rendu PCB / Schéma,
                      puis réessaie — aucun appel réseau CDN n'est tenté.
                    </p>
                    <pre className="viewer-fallback-err">{manifoldError}</pre>
                    <button
                      type="button"
                      className="viewer-chip"
                      onClick={() => {
                        setManifoldStatus("loading");
                        setManifoldError(null);
                        void preloadManifold()
                          .then(() => {
                            setManifoldStatus("ready");
                            log("manifold local pré-chargé (retry)");
                          })
                          .catch((e: unknown) => {
                            const msg = e instanceof Error ? e.message : String(e);
                            setManifoldStatus("error");
                            setManifoldError(msg);
                          });
                      }}
                    >
                      Réessayer Manifold local
                    </button>
                  </div>
                ) : (
                  <div className="viewer-empty">Chargement géométrie 3D locale…</div>
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
        shotName={shotName}
        onShotNameChange={setShotName}
        source={KIND[tab]}
        onShot={onShot}
        compileBusy={compiling}
      />

      {toasts.length > 0 && (
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} role="status" className={`toast toast-${t.kind}`}>
              {t.msg}
            </div>
          ))}
        </div>
      )}

      {pasteOpen && (
        <div
          className="modal-backdrop"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setPasteOpen(false);
              setPasteError(null);
            }
          }}
        >
          <div
            className="modal modal-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="paste-title"
            aria-describedby="paste-desc"
          >
            <h2 id="paste-title">Coller du TSX</h2>
            <p id="paste-desc" className="term-muted">
              Le contenu sera écrit dans <code translate="no">main.tsx</code> du
              Projet ouvert (écriture atomique, relecture par hash). Proposé
              uniquement quand le Projet est vide — si l'agent a écrit
              entre-temps, rien n'est écrasé.
            </p>
            <label htmlFor="paste-tsx" className="modal-label">
              Code TSX
            </label>
            <textarea
              id="paste-tsx"
              className="modal-textarea"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={10}
              spellCheck={false}
              translate="no"
              placeholder="export default () => (…)"
              autoFocus
            />
            {pasteError && (
              <p className="modal-error" role="alert">
                {pasteError}
              </p>
            )}
            <div className="modal-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPasteOpen(false);
                  setPasteError(null);
                }}
              >
                Annuler
              </Button>
              <Button size="sm" onClick={() => void savePastedTsx()} disabled={pasteBusy}>
                {pasteBusy ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
