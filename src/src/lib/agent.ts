// Routeur local T5 — moitié WebView (issue #60, spec #55, décision #48 C).
//
// Le routeur expose les mêmes opérations que le MCP (`batch`, `run_checks`,
// `search_parts`, `fab_export`, `preview_screenshot`, `code_patch`, `live`,
// `state`, `logs`, projets, hiérarchie) via le CŒUR `tools-core`, en appelant
// ses fonctions/orchestration directement. Effets injectés version WebView :
// - compile = moteur frontend (`compileBoard`, worker blob-url bundlé) via
//   le transport, normalisée avec les fonctions pures du cœur
//   (`computeStats`, extracteur strict, recomptes) ;
// - persistance = point de commit unique (`agent_commit_files`, atomique) ;
// - Projet = Projet ouvert backend (contexte relu à chaque appel).
// - réseau = proxy backend allowlisté (`agent_fetch`) — aucun appel réseau
//   direct depuis le frontend, aucun Bearer/token dans ce chemin.
//
// Délégation (aucune logique métier réécrite) : schémas Zod, gardes
// (Confinement, NO_PROJECT_OPEN), file (`enqueue`), store, patch/live/
// batch/board/checks/diagnostics/sourcing/fab-core, orchestration des
// LECTURES (`runPcbState`, `runLogsRead`, `readHierarchy`, `runChecks`,
// `runSearchParts`, `runPreviewScreenshot`).
// Écart documenté : `ToolsDeps` exige des effets SYNCHRONES (fs) indisponibles
// en WebView ; les 4 orchestrations avec écriture (`code_patch`, `live`,
// `batch`, `fab`) sont donc re-séquencées ici à l'identique (mêmes appels
// purs, mêmes gardes, même ordre snapshot→compile→gates→commit→rollback,
// mêmes champs de sortie), le commit devenant l'unique point atomique.
// Le partagé vit dans l'« orchestrateur » ci-dessous (`confinedProject`,
// `commitProjectFile`, `recordCompile`).
// Intègre T2 (#59) : gate route prioritaire (I12), refus board vide (I7),
// timeout/abort search (I5), hiérarchie confinée dynamique (I10, par reuse).
// La parité est vérifiée par `agent.test.ts` (même scénario, même stub,
// des deux côtés).
//
// Cale environnement (pas de logique) : `Buffer` minimal si absent
// (WebView sans polyfill) pour `exportFab` du cœur.

import { invoke } from "@tauri-apps/api/core";
import { enqueue } from "../../../pcb-mcp/src/tools-core/queue";
import {
  createMemoryStore,
  type MemoryStore,
} from "../../../pcb-mcp/src/tools-core/store";
import {
  requireConfinedProject,
  noProjectError,
} from "../../../pcb-mcp/src/tools-core/guards";
import {
  assertProjectMember,
} from "../../../pcb-mcp/src/tools-core/project-core";
import { applyAnchoredPatch } from "../../../pcb-mcp/src/tools-core/patch";
import {
  applyMove,
  applyReassignNet,
  applyRotate,
  applySwapPackage,
  getSelection,
  listViews,
  refuseLiveCreation,
  REFUSED_LIVE_OPS,
} from "../../../pcb-mcp/src/tools-core/live";
import { applyBatch, type BatchOp } from "../../../pcb-mcp/src/tools-core/batch";
import {
  boardExpectsRouting,
  boardRoutingDisabled,
  computeStats,
  emptyStats,
  isBoardRouted,
} from "../../../pcb-mcp/src/tools-core/board";
import {
  runDomainChecks as coreRunDomainChecks,
  runPlacementGate as coreRunPlacementGate,
  type CheckDomain,
} from "../../../pcb-mcp/src/tools-core/checks";
import {
  CDN_BANNER,
  extractEmbeddedDiagnostics,
  type CompileResult as CoreCompileResult,
} from "../../../pcb-mcp/src/tools-core/diagnostics";
import {
  exportFab,
  type FabOk,
} from "../../../pcb-mcp/src/tools-core/fab";
import {
  OFFLINE_BANNER as PREVIEW_OFFLINE_BANNER,
  type ReadPreviewResult,
} from "../../../pcb-mcp/src/tools-core/preview";
import {
  BatchExecuteInput,
  CodePatchInput,
  FabExportInput,
  LiveManageInput,
  LogsReadInput,
  PcbStateInput,
  PreviewScreenshotInput,
  ProjectCreateInput,
  ProjectOpenInput,
  RunChecksInput,
  SearchPartsInput,
  type BatchExecuteOutput,
} from "../../../pcb-mcp/src/tools-core/schemas";
import {
  liveOpNeedsQueue,
  readHierarchy,
  runChecks,
  runLogsRead,
  runPcbState,
  runPreviewScreenshot,
  runSearchParts,
  type ToolResult,
} from "../../../pcb-mcp/src/tools-core/tools";
import type { ToolsDeps } from "../../../pcb-mcp/src/tools-core/deps";
import { compileBoard } from "./compile";
import {
  closeProject as closeProjectCmd,
  createProject as createProjectCmd,
  currentProject as currentProjectCmd,
  listProjects as listProjectsCmd,
  openProject as openProjectCmd,
  readProjectMain,
} from "./projects";

if (
  typeof globalThis !== "undefined" &&
  (globalThis as Record<string, unknown>)["Buffer"] === undefined
) {
  const byteLength = (s: string): number => new TextEncoder().encode(s).length;
  const fromBase64 = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  (globalThis as Record<string, unknown>)["Buffer"] = {
    byteLength: (s: string) => byteLength(s),
    from: (input: string, enc?: string) => {
      if (enc === "base64") return fromBase64(input.replace(/\s+/g, ""));
      return new TextEncoder().encode(input);
    },
  };
}

// --- Transport (couture injectable : prod = invoke, tests = double) ---------

export interface AgentRegistry {
  projects: { path: string; lastOpened: string }[];
  lastOpened: string | null;
}

export interface AgentProjectItem {
  path: string;
  name: string;
  parent: string;
  exists: boolean;
  lastOpened: string;
}

export interface AgentContext {
  project: string | null;
  projects: AgentProjectItem[];
  lastOpened: string | null;
}

function registryOf(ctx: AgentContext): AgentRegistry {
  return {
    projects: ctx.projects.map((p) => ({ path: p.path, lastOpened: p.lastOpened })),
    lastOpened: ctx.lastOpened,
  };
}

export interface AgentCommit {
  path: string;
  code: string;
  circuitJson: unknown[];
}

export interface AgentCommitOut {
  path: string;
  code_hash: string;
  circuit_ok: boolean;
}

export interface AgentFabFile {
  name: string;
  base64: string;
}

export interface AgentFabArtifact {
  name: string;
  bytes: number;
  preview_url: string;
}

export interface AgentFabWriteOut {
  export_dir: string;
  artifacts: AgentFabArtifact[];
}

export interface AgentPreviewOut {
  found: boolean;
  source: string;
  name: string | null;
  data_url: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  preview_url: string | null;
  updated_at: string | null;
  banner: string | null;
  message: string | null;
  errors: number;
  warnings: number;
}

export interface AgentFetchOut {
  status: number;
  body: string;
}

export interface AgentCompileOut {
  circuitJson: unknown[];
  mode: string;
  banner: string | null;
}

export interface AgentTransport {
  getContext(): Promise<AgentContext>;
  createProject(path: string, template: "vide" | "demo"): Promise<string>;
  openProject(path: string): Promise<string>;
  closeProject(): Promise<void>;
  readMain(path?: string): Promise<{ path: string; code: string; hash: string }>;
  commitFiles(input: AgentCommit): Promise<AgentCommitOut>;
  fetchAllowed(url: string): Promise<AgentFetchOut>;
  fabWrite(
    path: string,
    projectName: string | undefined,
    files: AgentFabFile[],
  ): Promise<AgentFabWriteOut>;
  previewRead(
    source: string,
    name?: string | null,
    disableCdnLoading?: boolean,
  ): Promise<AgentPreviewOut>;
  compile(code: string, opts?: { disableCdnLoading?: boolean }): Promise<AgentCompileOut>;
}

/** Transport prod : commandes Tauri existantes + fines + worker frontend. */
export const tauriAgentTransport: AgentTransport = {
  async getContext(): Promise<AgentContext> {
    const listed = await listProjectsCmd();
    const project = await currentProjectCmd();
    return { project, projects: listed.projects, lastOpened: listed.lastOpened };
  },
  async createProject(path: string, template: "vide" | "demo") {
    return await createProjectCmd(path, template);
  },
  async openProject(path: string) {
    return await openProjectCmd(path);
  },
  async closeProject() {
    await closeProjectCmd();
  },
  async readMain(path?: string) {
    return await readProjectMain(path);
  },
  async commitFiles(input: AgentCommit) {
    return (await invoke("agent_commit_files", {
      path: input.path,
      code: input.code,
      circuitJson: input.circuitJson,
    })) as AgentCommitOut;
  },
  async fetchAllowed(url: string) {
    return (await invoke("agent_fetch", { url })) as AgentFetchOut;
  },
  async fabWrite(path: string, projectName: string | undefined, files: AgentFabFile[]) {
    return (await invoke("agent_fab_write", {
      path,
      projectName: projectName ?? null,
      files,
    })) as AgentFabWriteOut;
  },
  async previewRead(source: string, name?: string | null, disableCdnLoading?: boolean) {
    return (await invoke("agent_preview_read", {
      source,
      name: name ?? null,
      disableCdnLoading: disableCdnLoading ?? null,
    })) as AgentPreviewOut;
  },
  async compile(code: string, opts?: { disableCdnLoading?: boolean }) {
    const noop = (_msg: string) => undefined;
    const r = await compileBoard(noop, { disableCdnLoading: !!opts?.disableCdnLoading, code });
    return { circuitJson: r.circuitJson, mode: r.mode, banner: r.banner };
  },
};

// --- Routeur ---------------------------------------------------------------

export interface AgentRouter {
  /** Recharge contexte + code disque (à appeler sur `project-open-changed`). */
  refresh(): Promise<void>;
  projectList(): Promise<ToolResult<unknown>>;
  projectCurrent(): Promise<ToolResult<unknown>>;
  projectCreate(args: { path: string; template?: string }): Promise<ToolResult<unknown>>;
  projectOpen(args: { path: string }): Promise<ToolResult<unknown>>;
  projectClose(): Promise<ToolResult<unknown>>;
  pcbState(args?: { session_id?: string }): Promise<ToolResult<unknown>>;
  logsRead(args?: {
    cursor?: string;
    limit?: number;
    level?: "debug" | "info" | "warn" | "error";
  }): Promise<ToolResult<unknown>>;
  hierarchy(): Promise<{ json: unknown; text: string }>;
  codePatch(args: {
    session_id?: string;
    anchor: string;
    replacement: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>>;
  liveManage(args: {
    session_id?: string;
    op: string;
    refdes?: string;
    x?: number;
    y?: number;
    degrees?: number;
    footprint?: string;
    pin?: string;
    net?: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>>;
  batchExecute(args: {
    session_id?: string;
    operations: BatchOp[];
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>>;
  runChecks(args?: {
    session_id?: string;
    domain?: CheckDomain;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>>;
  searchParts(args: {
    session_id?: string;
    query: string;
    source?: string;
    limit?: number;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>>;
  fabExport(args?: {
    session_id?: string;
    project_name?: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>>;
  previewScreenshot(args: {
    session_id?: string;
    source: string;
    name?: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>>;
}

/** Compile normalisée parité sidecar : extracteur strict + stats du cœur.
 *  `mode` reste une chaîne libre (le repli inline frontend n'existe pas côté
 *  sidecar : divergence documentée, dégradé explicite). */
type LocalCompile = Omit<CoreCompileResult, "mode"> & { mode: string };

function pack<T>(output: T, extra?: Record<string, unknown>): ToolResult<T> {
  return {
    output,
    text: extra ? JSON.stringify({ ...output, ...extra }) : JSON.stringify(output),
  };
}

function boardBaseName(project: string | null): string {
  if (!project) return "board";
  const parts = project.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "board";
}

function invalidArgs(tool: string, message: string): Error {
  return new Error(`arguments invalides (${tool}) : ${message}`);
}

export function createAgentRouter(transport: AgentTransport): AgentRouter {
  const store: MemoryStore = createMemoryStore();
  let ctx: AgentContext = { project: null, projects: [], lastOpened: null };
  let loadedProject: string | null = null;

  async function ensureLoaded(): Promise<void> {
    ctx = await transport.getContext();
    if (ctx.project !== loadedProject) {
      if (ctx.project) {
        try {
          const main = await transport.readMain(ctx.project);
          if (main.code.trim()) store.setCode(main.code);
        } catch {
          // Projet illisible : les gardes refuseront proprement.
        }
      }
      loadedProject = ctx.project;
    }
  }

  function assertMemberCached(p: string): string {
    return assertProjectMember(p, registryOf(ctx));
  }

  // --- Orchestrateur partagé des écritures (revue) ---------------------------
  // Les 4 orchestrations avec écriture (`code_patch`, `live`, `batch`, `fab`)
  // partagent garde Confinement, point de commit unique (atomique) et statut
  // compile. Extraits ici (mêmes appels, mêmes gardes, même ordre
  // snapshot→compile→gates→commit→rollback, mêmes champs de sortie) ;
  // chaque orchestration garde sa logique propre (mutation, gates, export).
  // Comportement inchangé, parité vérifiée par `agent.test.ts`.

  /** Garde Confinement : Projet ouvert via le contexte relu à chaque appel. */
  function confinedProject(tool: string): {
    proj: string | null;
    scopeErr: { message: string; code: string } | null;
  } {
    return requireConfinedProject(tool, {
      resolveProject: () => ctx.project,
      assertMember: assertMemberCached,
    });
  }

  /** Point de commit unique : code + circuit-json via le backend (atomique).
   *  En échec : log + message français ; l'appelant restaure son snapshot. */
  async function commitProjectFile(
    tool: string,
    proj: string,
    code: string,
    circuitJson: unknown[],
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await transport.commitFiles({ path: proj, code, circuitJson });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      store.appendLog("error", "compile", `${tool} disque KO : ${message}`);
      return { ok: false, message };
    }
  }

  /** Enregistre le dernier statut compile (reflet `pcb_state`, parité sidecar). */
  function recordCompile(compiled: { errors: number; warnings: number }): void {
    store.setLastCompile({
      status: compiled.errors === 0 ? "ok" : "error",
      errors: compiled.errors,
      warnings: compiled.warnings,
    });
  }

  async function compileCore(
    code: string,
    opts?: { disableCdnLoading?: boolean },
  ): Promise<LocalCompile> {
    const disableCdnLoading = !!opts?.disableCdnLoading;
    const r = await transport.compile(code, { disableCdnLoading });
    if (r.mode === "echec") {
      const message = r.banner ?? "offline";
      return {
        circuitJson: [],
        diagnostics: [{ severity: "error", message, source: "compile" }],
        stats: emptyStats(),
        mode: "echec",
        banner: r.banner,
        errors: 1,
        warnings: 0,
      };
    }
    // Normalisation parité sidecar : extracteur strict + stats du cœur.
    const diagnostics = extractEmbeddedDiagnostics(r.circuitJson);
    const stats = computeStats(r.circuitJson);
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    const warnings = diagnostics.filter((d) => d.severity === "warning").length;
    const mode =
      r.mode === "worker-blob-local-nocdn" || disableCdnLoading
        ? "worker-blob-local-nocdn"
        : r.mode === "worker-blob-local"
          ? "worker-blob-local"
          : r.mode;
    return {
      circuitJson: r.circuitJson,
      diagnostics,
      stats,
      mode,
      banner: disableCdnLoading ? CDN_BANNER : r.banner,
      errors,
      warnings,
    };
  }

  function depsForPreview(preloaded: AgentPreviewOut | null): ToolsDeps {
    return depsBase({
      preview: {
        // Miroir sidecar : sans projet → dossier vide → refus NO_PROJECT_OPEN
        // du cœur (jamais de repli global) ; sinon précharge backend.
        previewDirFor: (proj) => (proj ? "project" : ""),
        previewFallbackDir: () => "",
        readPreview: (): ReadPreviewResult => {
          if (!preloaded) throw new Error("lecture précharge appelée sans projet");
          return {
            found: preloaded.found,
            source: preloaded.source,
            name: preloaded.name,
            dataUrl: preloaded.data_url,
            bytes: preloaded.bytes,
            width: preloaded.width,
            height: preloaded.height,
            previewUrl: preloaded.preview_url,
            updatedAt: preloaded.updated_at,
            banner: preloaded.banner,
            message: preloaded.message,
            errors: preloaded.errors,
            warnings: preloaded.warnings,
          };
        },
      },
    });
  }

  function depsBase(overrides?: Partial<ToolsDeps>): ToolsDeps {
    return {
      store,
      resolveProject: () => ctx.project,
      assertMember: assertMemberCached,
      boardName: () => boardBaseName(ctx.project),
      // Cast sûr : les lecteurs du cœur (`runChecks`) n'utilisent que
      // `mode === "echec"` + circuitJson/diagnostics/compteurs/stats/bannière,
      // tous présents. Les ops transcrites utilisent `compileCore` direct.
      compile: (async (code: string, opts?: { disableCdnLoading?: boolean }) =>
        compileCore(code, opts) as Promise<CoreCompileResult>) as ToolsDeps["compile"],
      persist: () => {
        throw new Error("persistance via commitFiles (point unique), jamais via deps");
      },
      // T2 I5 : le cœur propage un AbortSignal (timeout ≤ 15 s — 15 s pile :
      // défaut cœur + proxy backend) — honoré ici pour que le timeout du
      // cœur reste effectif même si `invoke` traînait.
      fetchFn: (async (url: string, init?: { signal?: AbortSignal }) => {
        const sig = init?.signal;
        if (sig?.aborted) throw new DOMException("aborted", "AbortError");
        const pending = transport.fetchAllowed(url);
        const r = sig
          ? await Promise.race([
              pending,
              new Promise<never>((_, reject) =>
                sig.addEventListener("abort", () =>
                  reject(new DOMException("aborted", "AbortError")),
                ),
              ),
            ])
          : await pending;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => JSON.parse(r.body) as unknown,
        };
      }) as ToolsDeps["fetchFn"],
      log: (level, source, message) => {
        store.appendLog(level, source, message);
      },
      io: {
        canonicalize: (p: string) => p,
        ensureLayout: () => {
          throw new Error("layout via commandes projet");
        },
        ensureCircuitFile: () => {
          throw new Error("circuit via commandes projet");
        },
        dirExists: () => false,
        mainExists: () => false,
        readMain: () => null,
        loadRegistry: () => registryOf(ctx),
        saveRegistry: () => {
          throw new Error("registre via commandes projet");
        },
        writeLock: () => {
          throw new Error("lock via commandes projet");
        },
        listProjects: () => ({
          projects: ctx.projects.map((p) => ({
            path: p.path,
            lastOpened: p.lastOpened,
            name: p.name,
            parent: p.parent,
            exists: p.exists,
          })),
          lastOpened: ctx.lastOpened,
        }),
      },
      fab: {
        projectNameForExport: () => {
          throw new Error("export via fabWrite");
        },
        resolveExportDir: () => {
          throw new Error("export via fabWrite");
        },
        mkdirp: () => undefined,
        writeFile: () => undefined,
        joinPath: (...parts: string[]) => parts.join("/"),
        toFileUrl: (p: string) => p,
      },
      preview: {
        previewDirFor: () => "",
        previewFallbackDir: () => "",
        readPreview: () => ({
          found: false,
          source: "",
          name: null,
          dataUrl: null,
          bytes: 0,
          width: null,
          height: null,
          previewUrl: null,
          updatedAt: null,
          banner: null,
          message: "précharge requise",
          errors: 1,
          warnings: 0,
        }),
      },
      ...overrides,
    };
  }

  // --- Projets : commandes existantes, mise en forme cœur -------------------

  async function projectList(): Promise<ToolResult<unknown>> {
    await ensureLoaded();
    return pack(await listProjectsForOutput());
  }

  async function listProjectsForOutput(): Promise<{
    projects: unknown[];
    lastOpened: string | null;
    current: string | null;
  }> {
    // Ordre de clés VERBATIM sidecar (`{...e, name, parent, exists}`) pour
    // une parité `text` stricte (JSON.stringify sensible à l'ordre).
    return {
      projects: ctx.projects.map((p) => ({
        path: p.path,
        lastOpened: p.lastOpened,
        name: p.name,
        parent: p.parent,
        exists: p.exists,
      })),
      lastOpened: ctx.lastOpened,
      current: ctx.project,
    };
  }

  async function projectCurrent(): Promise<ToolResult<unknown>> {
    await ensureLoaded();
    return pack({ current: ctx.project });
  }

  async function projectCreate(args: {
    path: string;
    template?: string;
  }): Promise<ToolResult<unknown>> {
    const parsed = ProjectCreateInput.safeParse(args);
    if (!parsed.success) throw invalidArgs("project_create", parsed.error.message);
    // `created` : heuristique exacte hors erreur (main lisible → existe déjà,
    // sinon le backend crée ou refuse avec le même message que le MCP).
    let existed = false;
    try {
      const before = await transport.readMain(args.path);
      existed = before.code !== undefined;
    } catch {
      existed = false;
    }
    const createdPath = await transport.createProject(
      args.path,
      (args.template as "vide" | "demo") ?? "vide",
    );
    await ensureLoadedRefresh(createdPath);
    store.appendLog(
      "info",
      "server",
      `project_create ${createdPath} (${existed ? "exists" : "created"})`,
    );
    return pack({
      path: createdPath,
      created: !existed,
      current: ctx.project,
    });
  }

  async function ensureLoadedRefresh(expected: string): Promise<void> {
    ctx = await transport.getContext();
    if (!ctx.project) ctx = { ...ctx, project: expected };
    try {
      const main = await transport.readMain(ctx.project ?? expected);
      if (main.code.trim()) store.setCode(main.code);
    } catch {
      // Gardes refuseront proprement.
    }
    loadedProject = ctx.project;
  }

  async function projectOpen(args: { path: string }): Promise<ToolResult<unknown>> {
    const parsed = ProjectOpenInput.safeParse(args);
    if (!parsed.success) throw invalidArgs("project_open", parsed.error.message);
    const opened = await transport.openProject(args.path);
    await ensureLoadedRefresh(opened);
    store.appendLog("info", "server", `project_open ${opened}`);
    return pack({ path: opened, current: ctx.project });
  }

  async function projectClose(): Promise<ToolResult<unknown>> {
    await transport.closeProject();
    ctx = await transport.getContext();
    store.appendLog("info", "server", "project_close → Accueil");
    return pack({ current: ctx.project });
  }

  // --- Lectures : orchestration du cœur réutilisée --------------------------

  async function pcbState(args?: { session_id?: string }): Promise<ToolResult<unknown>> {
    await ensureLoaded();
    const parsed = PcbStateInput.safeParse(args ?? {});
    if (!parsed.success) throw invalidArgs("pcb_state", parsed.error.message);
    return runPcbState(depsBase(), parsed.data);
  }

  async function logsRead(args?: {
    cursor?: string;
    limit?: number;
    level?: "debug" | "info" | "warn" | "error";
  }): Promise<ToolResult<unknown>> {
    await ensureLoaded();
    const parsed = LogsReadInput.safeParse(args ?? {});
    if (!parsed.success) throw invalidArgs("logs_read", parsed.error.message);
    return runLogsRead(depsBase(), parsed.data);
  }

  async function hierarchy(): Promise<{ json: unknown; text: string }> {
    await ensureLoaded();
    return readHierarchy(depsBase());
  }

  async function runChecksOp(args?: {
    session_id?: string;
    domain?: CheckDomain;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>> {
    await ensureLoaded();
    const parsed = RunChecksInput.safeParse(args ?? {});
    if (!parsed.success) throw invalidArgs("run_checks", parsed.error.message);
    return runChecks(depsBase(), parsed.data);
  }

  async function searchPartsOp(args: {
    session_id?: string;
    query: string;
    source?: string;
    limit?: number;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>> {
    await ensureLoaded();
    const parsed = SearchPartsInput.safeParse(args);
    if (!parsed.success) throw invalidArgs("search_parts", parsed.error.message);
    return runSearchParts(depsBase(), parsed.data);
  }

  async function previewScreenshot(args: {
    session_id?: string;
    source: string;
    name?: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>> {
    await ensureLoaded();
    const parsed = PreviewScreenshotInput.safeParse(args);
    if (!parsed.success)
      throw invalidArgs("preview_screenshot", parsed.error.message);
    // Précharge backend (sync requis par le cœur) puis orchestration du cœur.
    // Sans projet ou hors périmètre : pas d'appel backend, le cœur refuse
    // seul (dossier vide / scopeErr) — le lecteur n'est jamais appelé.
    let preloaded: AgentPreviewOut | null = null;
    if (ctx.project) {
      try {
        assertMemberCached(ctx.project);
        preloaded = await transport.previewRead(
          parsed.data.source,
          parsed.data.name ?? null,
          parsed.data.disableCdnLoading,
        );
      } catch {
        preloaded = null;
      }
    }
    return runPreviewScreenshot(depsForPreview(preloaded), parsed.data);
  }

  // --- Mutations : re-séquencées à l'identique (voir en-tête) ---------------

  async function codePatch(args: {
    session_id?: string;
    anchor: string;
    replacement: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>> {
    const parsed = CodePatchInput.safeParse(args);
    if (!parsed.success) throw invalidArgs("code_patch", parsed.error.message);
    return enqueue(async () => {
      await ensureLoaded();
      const sessionId = parsed.data.session_id ?? "default";
      const { proj, scopeErr } = confinedProject("code_patch");
      if (!proj || scopeErr) {
        const err = scopeErr ?? noProjectError("code_patch");
        return pack(
          {
            sessionId,
            applied: false as const,
            ready: false,
            stats: emptyStats(),
            diagnostics: [
              { severity: "error", message: err.message, source: "code_patch" },
            ],
            mode: "refuse",
            banner: null as string | null,
            errors: 1,
            warnings: 0,
            circuitJsonLength: 0,
            circuitJson: [] as unknown[],
          },
          { ...err },
        );
      }
      const patched = applyAnchoredPatch(
        store.getCode(),
        parsed.data.anchor,
        parsed.data.replacement,
      );
      if (!patched.ok) {
        const output = {
          sessionId,
          applied: false as const,
          ready: store.getBoardState(boardBaseName(ctx.project), sessionId).ready,
          stats: emptyStats(),
          diagnostics: [
            { severity: "error", message: patched.message, source: "code_patch" },
          ],
          mode: "echec",
          banner: null as string | null,
          errors: 1,
          warnings: 0,
          circuitJsonLength: 0,
          circuitJson: [] as unknown[],
        };
        store.appendLog("error", "compile", `code_patch rejeté : ${patched.message}`);
        return pack(output);
      }
      const compiled = await compileCore(patched.code, {
        disableCdnLoading: parsed.data.disableCdnLoading,
      });
      recordCompile(compiled);
      if (compiled.errors === 0) {
        const committed = await commitProjectFile("code_patch", proj, patched.code, compiled.circuitJson);
        if (!committed.ok) {
          return pack({
            sessionId,
            applied: false as const,
            ready: false,
            stats: compiled.stats,
            diagnostics: [{ severity: "error", message: committed.message, source: "code_patch" }],
            mode: "echec",
            banner: compiled.banner,
            errors: 1,
            warnings: compiled.warnings,
            circuitJsonLength: 0,
            circuitJson: [] as unknown[],
          });
        }
        store.setCode(patched.code);
        store.appendLog(
          "info",
          "compile",
          `code_patch ok : ${compiled.stats.total} éléments, 0 erreur`,
        );
      } else {
        store.setCode(patched.code);
        store.appendLog(
          "error",
          "compile",
          `code_patch compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
        );
      }
      return pack({
        sessionId,
        applied: true as const,
        ready: compiled.errors === 0,
        stats: compiled.stats,
        diagnostics: compiled.diagnostics,
        mode: compiled.mode,
        banner: compiled.banner,
        errors: compiled.errors,
        warnings: compiled.warnings,
        circuitJsonLength: compiled.circuitJson.length,
        circuitJson: compiled.circuitJson,
      });
    });
  }

  async function liveManage(args: {
    session_id?: string;
    op: string;
    refdes?: string;
    x?: number;
    y?: number;
    degrees?: number;
    footprint?: string;
    pin?: string;
    net?: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>> {
    const parsed = LiveManageInput.safeParse(args);
    if (!parsed.success) throw invalidArgs("live_manage", parsed.error.message);
    const run = async (): Promise<ToolResult<unknown>> => {
      await ensureLoaded();
      const { proj: projLive, scopeErr: scopeErrLive } = confinedProject("live_manage");
      if (!projLive || scopeErrLive) {
        const err = scopeErrLive ?? noProjectError("live_manage");
        return pack(
          {
            sessionId: parsed.data.session_id ?? "default",
            op: (parsed.data.op ?? "").trim(),
            applied: false as const,
            ready: false,
            stats: emptyStats(),
            diagnostics: [{ severity: "error", message: err.message, source: "live_manage" }],
            mode: "refuse",
            banner: null as string | null,
            errors: 1,
            warnings: 0,
            circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: null as string | null,
            selection: null,
            views: null as string[] | null,
            message: err.message,
          },
          { ...err },
        );
      }
      const sessionId = parsed.data.session_id ?? "default";
      const asked = (parsed.data.op ?? "").trim();
      const refused = (REFUSED_LIVE_OPS as readonly string[]).includes(asked);
      if (refused || asked === "create") {
        const message = refuseLiveCreation(asked || "create");
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        const output = {
          sessionId, op: asked, applied: false as const, ready,
          stats: emptyStats(),
          diagnostics: [{ severity: "error", message, source: "live_manage" }],
          mode: "refuse", banner: null as string | null,
          errors: 1, warnings: 0, circuitJsonLength: 0,
          circuitJson: [] as unknown[],
          code: null as string | null, selection: null,
          views: null as string[] | null, message,
        };
        store.appendLog("error", "compile", `live_manage ${asked} refusé : ${message}`);
        return pack(output);
      }
      if (asked === "select") {
        if (!parsed.data.refdes) {
          const message = "select exige refdes (ex R1)";
          const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
          return pack({
            sessionId, op: asked, applied: false as const, ready,
            stats: emptyStats(),
            diagnostics: [{ severity: "error", message, source: "live_manage" }],
            mode: "refuse", banner: null as string | null,
            errors: 1, warnings: 0, circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: store.getCode(), selection: null,
            views: null as string[] | null, message,
          });
        }
        const selection = getSelection(store.getCode(), parsed.data.refdes);
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        if (!selection) {
          const message = `composant ${parsed.data.refdes} introuvable dans le TSX`;
          return pack({
            sessionId, op: asked, applied: false as const, ready,
            stats: emptyStats(),
            diagnostics: [{ severity: "error", message, source: "live_manage" }],
            mode: "lecture", banner: null as string | null,
            errors: 1, warnings: 0, circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: store.getCode(), selection: null,
            views: null as string[] | null, message,
          });
        }
        return pack({
          sessionId, op: asked, applied: true as const, ready,
          stats: emptyStats(), diagnostics: [],
          mode: "lecture", banner: null as string | null,
          errors: 0, warnings: 0, circuitJsonLength: 0,
          circuitJson: [] as unknown[],
          code: store.getCode(), selection,
          views: null as string[] | null, message: null as string | null,
        });
      }
      if (asked === "view") {
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        return pack({
          sessionId, op: asked, applied: true as const, ready,
          stats: emptyStats(), diagnostics: [],
          mode: "lecture", banner: null as string | null,
          errors: 0, warnings: 0, circuitJsonLength: 0,
          circuitJson: [] as unknown[],
          code: store.getCode(), selection: null,
          views: listViews(), message: null as string | null,
        });
      }
      const code = store.getCode();
      let mutated: { ok: true; code: string } | { ok: false; message: string };
      switch (asked) {
        case "move":
          if (parsed.data.x === undefined || parsed.data.y === undefined) {
            mutated = { ok: false as const, message: "move exige x et y (nombres, mm)" };
          } else {
            mutated = applyMove(code, parsed.data.refdes ?? "", parsed.data.x, parsed.data.y);
          }
          break;
        case "rotate":
          if (parsed.data.degrees === undefined) {
            mutated = { ok: false as const, message: "rotate exige degrees (nombre)" };
          } else {
            mutated = applyRotate(code, parsed.data.refdes ?? "", parsed.data.degrees);
          }
          break;
        case "swap_package":
          if (!parsed.data.footprint) {
            mutated = { ok: false as const, message: "swap_package exige footprint (ex 0603)" };
          } else {
            mutated = applySwapPackage(code, parsed.data.refdes ?? "", parsed.data.footprint);
          }
          break;
        case "reassign_net":
          if (!parsed.data.pin || !parsed.data.net) {
            mutated = {
              ok: false as const,
              message: "reassign_net exige pin et net (ex pin1, GND)",
            };
          } else {
            mutated = applyReassignNet(code, parsed.data.refdes ?? "", parsed.data.pin, parsed.data.net);
          }
          break;
        default: {
          const message =
            `op live "${asked}" inconnue (live V1 : move | rotate | swap_package | reassign_net + select/view) — ` +
            `création/suppression via code_patch`;
          const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
          const output = {
            sessionId, op: asked, applied: false as const, ready,
            stats: emptyStats(),
            diagnostics: [{ severity: "error", message, source: "live_manage" }],
            mode: "refuse", banner: null as string | null,
            errors: 1, warnings: 0, circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: null as string | null, selection: null,
            views: null as string[] | null, message,
          };
          store.appendLog("error", "compile", `live_manage ${asked} inconnu`);
          return pack(output);
        }
      }
      if (!mutated.ok) {
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        const output = {
          sessionId, op: asked, applied: false as const, ready,
          stats: emptyStats(),
          diagnostics: [{ severity: "error", message: mutated.message, source: "live_manage" }],
          mode: "refuse", banner: null as string | null,
          errors: 1, warnings: 0, circuitJsonLength: 0,
          circuitJson: [] as unknown[],
          code: null as string | null, selection: null,
          views: null as string[] | null, message: mutated.message,
        };
        store.appendLog("error", "compile", `live_manage ${asked} rejeté : ${mutated.message}`);
        return pack(output);
      }
      const compiled = await compileCore(mutated.code, {
        disableCdnLoading: parsed.data.disableCdnLoading,
      });
      const ready = compiled.errors === 0;
      recordCompile(compiled);
      if (compiled.errors === 0) {
        const committed = await commitProjectFile("live_manage", projLive, mutated.code, compiled.circuitJson);
        if (!committed.ok) {
          return pack({
            sessionId, op: asked, applied: false as const, ready: false,
            stats: compiled.stats,
            diagnostics: [{ severity: "error", message: committed.message, source: "live_manage" }],
            mode: "echec", banner: compiled.banner,
            errors: 1, warnings: compiled.warnings, circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: mutated.code, selection: null,
            views: null as string[] | null, message: committed.message,
          });
        }
        store.setCode(mutated.code);
        store.appendLog(
          "info", "compile",
          `live_manage ${asked} ok : ${compiled.stats.total} éléments, 0 erreur`,
        );
      } else {
        store.setCode(mutated.code);
        store.appendLog(
          "error", "compile",
          `live_manage ${asked} compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
        );
      }
      return pack({
        sessionId, op: asked, applied: true as const, ready,
        stats: compiled.stats, diagnostics: compiled.diagnostics,
        mode: compiled.mode, banner: compiled.banner,
        errors: compiled.errors, warnings: compiled.warnings,
        circuitJsonLength: compiled.circuitJson.length,
        circuitJson: compiled.circuitJson,
        code: mutated.code, selection: null,
        views: null as string[] | null, message: null as string | null,
      });
    };
    if (!liveOpNeedsQueue(parsed.data.op ?? "")) return run();
    return enqueue(run);
  }

  async function batchExecute(args: {
    session_id?: string;
    operations: BatchOp[];
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>> {
    const parsed = BatchExecuteInput.safeParse(args);
    if (!parsed.success) throw invalidArgs("batch_execute", parsed.error.message);
    return enqueue(async () => {
      await ensureLoaded();
      const sessionId = parsed.data.session_id ?? "default";
      const { proj: projBatch, scopeErr: scopeErrBatch } = confinedProject("batch_execute");
      if (!projBatch || scopeErrBatch) {
        const err = scopeErrBatch ?? noProjectError("batch_execute");
        return pack(
          {
            sessionId, applied: false as const, ready: false,
            failedOpIndex: null as number | null, rolledBack: false,
            stats: emptyStats(),
            diagnostics: [{ severity: "error", message: err.message, source: "batch_execute" }],
            mode: "refuse", banner: null as string | null,
            errors: 1, warnings: 0, circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: null as string | null,
          },
          { ...err },
        );
      }
      const ops = (parsed.data.operations ?? []) as BatchOp[];
      if (!Array.isArray(ops) || ops.length === 0) {
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        const output = {
          sessionId, applied: false as const, ready,
          failedOpIndex: null as number | null, rolledBack: false,
          stats: emptyStats(),
          diagnostics: [{
            severity: "error",
            message: "lot vide : fournissez au moins une opération",
            source: "batch_execute",
          }],
          mode: "refuse", banner: null as string | null,
          errors: 1, warnings: 0, circuitJsonLength: 0,
          circuitJson: [] as unknown[],
          code: null as string | null,
        };
        store.appendLog("error", "compile", "batch_execute rejeté : lot vide");
        return pack(output);
      }
      const snap = store.snapshot();
      const batched = applyBatch(snap.code, ops);
      if (!batched.ok) {
        store.restore(snap);
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        const output = {
          sessionId, applied: false as const, ready,
          failedOpIndex: batched.failedIndex as number | null, rolledBack: true,
          stats: emptyStats(),
          diagnostics: [{ severity: "error", message: batched.message, source: "batch_execute" }],
          mode: "echec", banner: null as string | null,
          errors: 1, warnings: 0, circuitJsonLength: 0,
          circuitJson: [] as unknown[],
          code: snap.code,
        };
        store.appendLog(
          "error", "compile",
          `batch_execute rollback : op ${batched.failedIndex} — ${batched.message}`,
        );
        return pack(output);
      }
      store.setCode(batched.code);
      const compiled = await compileCore(batched.code, {
        disableCdnLoading: parsed.data.disableCdnLoading,
      });
      // T2 I12 (#59) : motif du gate prioritaire sur les diagnostics compile.
      if (ops.some((o) => o.kind === "route") && compiled.mode !== "echec") {
        const gatePre = await coreRunPlacementGate(compiled.circuitJson, batched.code);
        const preBlock = !gatePre.routingAllowed
          ? (gatePre.blockReason ?? "placement non vert")
          : !isBoardRouted(compiled.circuitJson)
            ? "board non routé : aucune pcb_trace avec route dans le circuit-json — vérifiez le placement puis relancez"
            : null;
        if (preBlock) {
          store.restore(snap);
          const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
          const output = {
            sessionId, applied: false as const, ready,
            failedOpIndex: null as number | null, rolledBack: true,
            stats: emptyStats(),
            diagnostics: [{
              severity: "error",
              message: `routing refusé : ${preBlock}`,
              source: "batch_execute",
            }],
            mode: "echec", banner: compiled.banner,
            errors: 1, warnings: compiled.warnings,
            circuitJsonLength: 0, circuitJson: [] as unknown[],
            code: snap.code,
          };
          store.appendLog(
            "error", "compile",
            `batch_execute rollback : routing refusé — ${preBlock}`,
          );
          return pack(output);
        }
      }
      if (compiled.errors !== 0) {
        store.restore(snap);
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        const output = {
          sessionId, applied: false as const, ready,
          failedOpIndex: null as number | null, rolledBack: true,
          stats: emptyStats(), diagnostics: compiled.diagnostics,
          mode: "echec", banner: compiled.banner,
          errors: compiled.errors, warnings: compiled.warnings,
          circuitJsonLength: 0, circuitJson: [] as unknown[],
          code: snap.code,
        };
        store.appendLog(
          "error", "compile",
          `batch_execute rollback : compile en erreur — ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
        );
        return pack(output);
      }
      if (ops.some((o) => o.kind === "route")) {
        const gate = await coreRunPlacementGate(compiled.circuitJson, batched.code);
        const blockReason = !gate.routingAllowed
          ? (gate.blockReason ?? "placement non vert")
          : !isBoardRouted(compiled.circuitJson)
            ? "board non routé : aucune pcb_trace avec route dans le circuit-json — vérifiez le placement puis relancez"
            : null;
        if (blockReason) {
          store.restore(snap);
          const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
          const output = {
            sessionId, applied: false as const, ready,
            failedOpIndex: null as number | null, rolledBack: true,
            stats: emptyStats(),
            diagnostics: [{
              severity: "error",
              message: `routing refusé : ${blockReason}`,
              source: "batch_execute",
            }],
            mode: "echec", banner: compiled.banner,
            errors: 1, warnings: compiled.warnings,
            circuitJsonLength: 0, circuitJson: [] as unknown[],
            code: snap.code,
          };
          store.appendLog(
            "error", "compile",
            `batch_execute rollback : routing refusé — ${blockReason}`,
          );
          return pack(output);
        }
      }
      store.setLastCompile({ status: "ok", errors: 0, warnings: compiled.warnings });
      store.appendLog(
        "info", "compile",
        `batch_execute ok : ${ops.length} ops, ${compiled.stats.total} éléments, 0 erreur`,
      );
      const committed = await commitProjectFile("batch_execute", projBatch, batched.code, compiled.circuitJson);
      if (!committed.ok) {
        store.restore(snap);
        const ready = store.getBoardState(boardBaseName(ctx.project), sessionId).ready;
        return pack({
          sessionId, applied: false as const, ready,
          failedOpIndex: null as number | null, rolledBack: true,
          stats: compiled.stats,
          diagnostics: [{ severity: "error", message: committed.message, source: "batch_execute" }],
          mode: "echec", banner: compiled.banner,
          errors: 1, warnings: compiled.warnings,
          circuitJsonLength: 0, circuitJson: [] as unknown[],
          code: snap.code,
        });
      }
      return pack({
        sessionId, applied: true as const, ready: true,
        failedOpIndex: null as number | null, rolledBack: false,
        stats: compiled.stats, diagnostics: compiled.diagnostics,
        mode: compiled.mode, banner: compiled.banner,
        errors: 0, warnings: compiled.warnings,
        circuitJsonLength: compiled.circuitJson.length,
        circuitJson: compiled.circuitJson,
        code: batched.code,
      });
    });
  }

  async function fabExport(args?: {
    session_id?: string;
    project_name?: string;
    disableCdnLoading?: boolean;
  }): Promise<ToolResult<unknown>> {
    const parsed = FabExportInput.safeParse(args ?? {});
    if (!parsed.success) throw invalidArgs("fab_export", parsed.error.message);
    await ensureLoaded();
    const sessionId = parsed.data.session_id ?? "default";
    const { proj: projFab, scopeErr: scopeErrFab } = confinedProject("fab_export");
    if (!projFab || scopeErrFab) {
      const err = scopeErrFab ?? noProjectError("fab_export");
      return pack(
        {
          sessionId, ready: false as const, mode: "refuse",
          banner: null as string | null, errors: 1, warnings: 0,
          counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
          gerberNames: [], gerberPreview: "", bomCsv: "", pnpCsv: "",
          kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
          kicadZip: { bytes: 0, previewUrl: "" },
          fabZip: { bytes: 0, previewUrl: "" },
          artifacts: [], exportDir: "", message: err.message,
        },
        { ...err },
      );
    }
    const code = store.getCode();
    const compiled = await compileCore(code, {
      disableCdnLoading: parsed.data.disableCdnLoading,
    });
    const emptyFabOutput = (message: string) => ({
      sessionId, ready: false as const, mode: "refuse" as const,
      banner: compiled.banner, errors: 1, warnings: 0,
      counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
      gerberNames: [] as string[], gerberPreview: "", bomCsv: "", pnpCsv: "",
      kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
      kicadZip: { bytes: 0, previewUrl: "" },
      fabZip: { bytes: 0, previewUrl: "" },
      artifacts: [],
      exportDir: "",
      message,
    });
    if (compiled.mode === "echec") {
      store.appendLog(
        "error", "export",
        `fab_export impossible : compile en erreur — ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
      );
      return pack({
        sessionId, ready: false as const, mode: "echec",
        banner: compiled.banner, errors: compiled.errors, warnings: compiled.warnings,
        counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
        gerberNames: [], gerberPreview: "", bomCsv: "", pnpCsv: "",
        kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
        kicadZip: { bytes: 0, previewUrl: "" },
        fabZip: { bytes: 0, previewUrl: "" },
        artifacts: [], exportDir: "",
        message: `compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"} — corrigez via code_patch avant tout export`,
      });
    }
    // T2 I7 (#59) : Projet vide (0 composant) → refus explicite avant tout
    // gate DRC/routage (qui seraient verts sur un board vide).
    if (compiled.stats.components === 0) {
      const reason =
        "board vide (0 composant) : ajoutez au moins un composant via code_patch avant tout export";
      store.appendLog("error", "export", `fab_export refusé : ${reason}`);
      return pack(emptyFabOutput(reason));
    }
    if (boardRoutingDisabled(code)) {
      const reason =
        "routingDisabled déclaré sur <board> — retirez-le via code_patch et routez (batch_execute route) avant tout export";
      store.appendLog("error", "export", `fab_export refusé : board non routé — ${reason}`);
      return pack(emptyFabOutput(`board non routé : ${reason}`));
    }
    const gate = await coreRunPlacementGate(compiled.circuitJson, code);
    const allViolations = await coreRunDomainChecks(compiled.circuitJson, "all");
    const drcViolations = gate.routingAllowed
      ? allViolations
      : allViolations.filter((v) => v.domain !== "routing");
    if (!gate.placementGreen || drcViolations.length > 0) {
      const reason =
        gate.blockReason ?? `${drcViolations.length} violation(s) DRC à corriger`;
      store.setDrcViolations(drcViolations.length);
      store.appendLog("error", "export", `fab_export refusé : DRC rouge — ${reason}`);
      return pack(
        emptyFabOutput(
          `DRC rouge : ${reason} — corrigez via code_patch/run_checks avant tout export`,
        ),
      );
    }
    store.setDrcViolations(0);
    if (boardExpectsRouting(code) && !isBoardRouted(compiled.circuitJson)) {
      const reason =
        "aucune trace routée dans le circuit-json — routez via batch_execute (op route) avant tout export";
      store.appendLog("error", "export", `fab_export refusé : board non routé — ${reason}`);
      return pack(emptyFabOutput(`board non routé : ${reason}`));
    }
    if (compiled.errors > 0) {
      store.appendLog(
        "error", "export",
        `fab_export impossible : compile en erreur — ${compiled.diagnostics.find((d) => d.severity === "error")?.message ?? "inconnu"}`,
      );
      return pack({
        sessionId, ready: false as const, mode: "echec",
        banner: compiled.banner, errors: compiled.errors, warnings: compiled.warnings,
        counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
        gerberNames: [], gerberPreview: "", bomCsv: "", pnpCsv: "",
        kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
        kicadZip: { bytes: 0, previewUrl: "" },
        fabZip: { bytes: 0, previewUrl: "" },
        artifacts: [], exportDir: "",
        message: `compile en erreur : ${compiled.diagnostics.find((d) => d.severity === "error")?.message ?? "inconnu"} — corrigez via code_patch avant tout export`,
      });
    }
    const fab = await exportFab(compiled.circuitJson as unknown[], {
      projectName: exportProjectNameForExport(projFab, parsed.data.project_name),
    });
    if (!fab.ok) {
      store.appendLog("error", "export", `fab_export impossible : ${fab.message}`);
      return pack({
        sessionId, ready: false as const, mode: "echec",
        banner: compiled.banner, errors: 1, warnings: 0,
        counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
        gerberNames: [], gerberPreview: "", bomCsv: "", pnpCsv: "",
        kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
        kicadZip: { bytes: 0, previewUrl: "" },
        fabZip: { bytes: 0, previewUrl: "" },
        artifacts: [], exportDir: "", message: fab.message,
      });
    }
    const out = fab as FabOk;
    const files: AgentFabFile[] = [];
    // base64 sans spread (les gerbers dépassent la limite d'arguments).
    const toB64 = (s: string): string => {
      const bytes = new TextEncoder().encode(s);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    };
    for (const [name, content] of Object.entries(out.gerberFiles)) {
      files.push({ name: `gerbers/${name}`, base64: toB64(content) });
    }
    files.push({ name: "bom.csv", base64: toB64(out.bomCsv) });
    files.push({ name: "pick-and-place.csv", base64: toB64(out.pnpCsv) });
    files.push({ name: `${out.projectName}.kicad_pcb`, base64: toB64(out.kicadPcb) });
    files.push({ name: `${out.projectName}.kicad_sch`, base64: toB64(out.kicadSch) });
    files.push({ name: `${out.projectName}.kicad_pro`, base64: toB64(out.kicadPro) });
    files.push({ name: "kicad_project.zip", base64: out.kicadZipBase64 });
    files.push({ name: "fab_upload.zip", base64: out.fabZipBase64 });
    const written = await transport.fabWrite(projFab, out.projectName, files);
    store.appendLog(
      "info", "export",
      `fab_export ok : ${out.counts.gerberFiles} gerbers, BOM ${out.counts.bomRows} lignes, PnP ${out.counts.pnpRows} lignes, kicad silencieux → ${written.export_dir}`,
    );
    return pack(
      shapeFabOkOutput(sessionId, compiled, out, {
        export_dir: written.export_dir,
        artifacts: written.artifacts,
      }),
    );
  }

  // Nom projet prod (miroir sidecar hors override de tests : le basename ;
  // la sanitisation `default`→`board` est faite par `exportFab` des deux côtés).
  function exportProjectNameForExport(
    projectPath: string,
    explicitName: string | undefined,
  ): string {
    return explicitName ?? boardBaseName(projectPath);
  }

  return {
    refresh: ensureLoaded,
    projectList: () => projectList(),
    projectCurrent: () => projectCurrent(),
    projectCreate: (args) => enqueue(() => projectCreate(args)),
    projectOpen: (args) => enqueue(() => projectOpen(args)),
    projectClose: () => enqueue(() => projectClose()),
    pcbState: (args) => pcbState(args),
    logsRead: (args) => logsRead(args),
    hierarchy: () => hierarchy(),
    codePatch: (args) => codePatch(args),
    liveManage: (args) => liveManage(args),
    batchExecute: (args) => batchExecute(args),
    runChecks: (args) => runChecksOp(args),
    searchParts: (args) => searchPartsOp(args),
    fabExport: (args) => fabExport(args),
    previewScreenshot: (args) => previewScreenshot(args),
  };
}

/** Mise en forme `fab_export` ok (champs VERBATIM MCP) : testée en unité
 *  avec un `FabOk` fabriqué (les convertisseurs exigent une vraie géométrie,
 *  non stubable en parité automatisée — voir `agent.test.ts`). */
export function shapeFabOkOutput(
  sessionId: string,
  compiled: { mode: string; banner: string | null; warnings: number },
  out: FabOk,
  written: { export_dir: string; artifacts: AgentFabArtifact[] },
): Record<string, unknown> {
  const byName = (n: string) => written.artifacts.find((a) => a.name === n);
  const utf8len = (s: string): number => new TextEncoder().encode(s).length;
  return {
    sessionId, ready: true as const, mode: compiled.mode,
    banner: compiled.banner, errors: 0, warnings: compiled.warnings,
    counts: out.counts,
    gerberNames: out.gerberNames,
    gerberPreview: out.gerberPreview,
    bomCsv: out.bomCsv,
    pnpCsv: out.pnpCsv,
    kicad: {
      pcbBytes: utf8len(out.kicadPcb),
      schBytes: utf8len(out.kicadSch),
      proBytes: utf8len(out.kicadPro),
      pcbPreview: out.kicadPcbPreview,
    },
    kicadZip: {
      bytes: out.kicadZipBytes,
      previewUrl: byName("kicad_project.zip")?.preview_url ?? "",
    },
    fabZip: {
      bytes: out.fabZipBytes,
      previewUrl: byName("fab_upload.zip")?.preview_url ?? "",
    },
    artifacts: written.artifacts.map((a) => ({
      name: a.name,
      bytes: a.bytes,
      previewUrl: a.preview_url,
    })),
    exportDir: written.export_dir,
    message: null as string | null,
  };
}

/** Routeur singleton (transport prod). T6 branchera `agent.ts` dessus. */
let defaultRouter: AgentRouter | null = null;
export function getAgentRouter(): AgentRouter {
  if (!defaultRouter) defaultRouter = createAgentRouter(tauriAgentTransport);
  return defaultRouter;
}

/** Vrai si l'erreur backend = garde projet (aucun appel sans Projet ouvert). */
export function isNoProjectOpen(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("NO_PROJECT_OPEN");
}

/** Vrai si l'erreur backend = Confinement (hors Registre). */
export function isOutOfScope(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("hors périmètre") || msg.includes("OUT_OF_SCOPE");
}

export { PREVIEW_OFFLINE_BANNER };
export type { BatchExecuteOutput };
export type { BatchOp };
