// Orchestration des outils du cœur (T1, #56) : SEULE implémentation des
// règles, consommée par l'adaptateur MCP externe ET (demain) le routeur
// agent. Chaque fonction reçoit `ToolsDeps` (compile/persistance/résolution
// Projet/journal injectés) et retourne `{ output, text }` — `output` est le
// `structuredContent` Zod, `text` le JSON du `content[]` (avec `...err`
// fusionné comme l'adaptateur historique). L'adaptateur (`src/mcp.ts`) ne
// fait plus que : valider (SDK) → filer (`enqueue`) → appeler ici →
// mettre en forme. Aucun import node: — jamais d'effet direct.
// Logique reprise VERBATIM des handlers `src/mcp.ts` (avant T1).
import { z } from "zod";
import { applyAnchoredPatch } from "./patch.js";
import {
  applyMove,
  applyReassignNet,
  applyRotate,
  applySwapPackage,
  getSelection,
  listViews,
  refuseLiveCreation,
  REFUSED_LIVE_OPS,
} from "./live.js";
import { applyBatch, BATCH_MAX_OPS, type BatchOp } from "./batch.js";
import {
  boardExpectsRouting,
  boardRoutingDisabled,
  emptyStats,
  isBoardRouted,
} from "./board.js";
import {
  runDomainChecks as coreRunDomainChecks,
  runPlacementGate as coreRunPlacementGate,
  type CheckDomain,
} from "./checks.js";
import { extractEmbeddedDiagnostics } from "./diagnostics.js";
import type { ToolsDeps } from "./deps.js";
export { requireConfinedProject } from "./guards.js";
import { noProjectError, requireConfinedProject } from "./guards.js";
import {
  NO_PROJECT_OPEN,
  upsertRegistry,
} from "./project-core.js";
import {
  exportFab,
  sanitizeSegment,
  writeFabArtifacts,
  type FabOk,
} from "./fab.js";
import {
  OFFLINE_BANNER as PREVIEW_OFFLINE_BANNER,
  type PreviewSource,
} from "./preview.js";
import {
  BatchExecuteInput,
  CodePatchInput,
  CodePatchOutput,
  FabExportInput,
  FabExportOutput,
  LiveManageInput,
  LiveManageOutput,
  LogsReadInput,
  PcbStateInput,
  PreviewScreenshotInput,
  PreviewScreenshotOutput,
  ProjectCreateInput,
  ProjectOpenInput,
  RunChecksInput,
  RunChecksOutput,
  SearchPartsInput,
  SearchPartsOutput,
  type BatchExecuteOutput,
} from "./schemas.js";
import { searchParts as searchPartsCore } from "./sourcing.js";
import { getHierarchy as getHierarchyCore, PROTOCOL_VERSION } from "./store.js";

export type ProjectCreateArgs = z.infer<typeof ProjectCreateInput>;
export type ProjectOpenArgs = z.infer<typeof ProjectOpenInput>;
export type PcbStateArgs = z.infer<typeof PcbStateInput>;
export type LogsReadArgs = z.infer<typeof LogsReadInput>;
export type CodePatchArgs = z.infer<typeof CodePatchInput>;
export type RunChecksArgs = z.infer<typeof RunChecksInput>;
export type LiveManageArgs = z.infer<typeof LiveManageInput>;
export type PreviewScreenshotArgs = z.infer<typeof PreviewScreenshotInput>;
export type BatchExecuteArgs = z.infer<typeof BatchExecuteInput>;
export type SearchPartsArgs = z.infer<typeof SearchPartsInput>;
export type FabExportArgs = z.infer<typeof FabExportInput>;

export interface ToolResult<T> {
  output: T;
  text: string;
}

function pack<T>(output: T, extra?: Record<string, unknown>): ToolResult<T> {
  return {
    output,
    text: extra ? JSON.stringify({ ...output, ...extra }) : JSON.stringify(output),
  };
}

export async function runProjectList(deps: ToolsDeps): Promise<
  ToolResult<{ projects: unknown[]; lastOpened: string | null; current: string | null }>
> {
  const { projects, lastOpened } = deps.io.listProjects();
  const output = { projects, lastOpened, current: deps.resolveProject() };
  return pack(output);
}

export async function runProjectCurrent(
  deps: ToolsDeps,
): Promise<ToolResult<{ current: string | null }>> {
  const output = { current: deps.resolveProject() };
  return pack(output);
}

export async function runProjectCreate(
  deps: ToolsDeps,
  args: ProjectCreateArgs,
): Promise<ToolResult<{ path: string; created: boolean; current: string | null }>> {
  const { path: p, template } = args;
  // Frontière outil : normalisation canonique unique (sans slash,
  // symlinks résolus si existe) — même règle que le backend Rust.
  const dir = deps.io.canonicalize(p);
  const outcome = deps.io.ensureLayout(dir, template ?? "vide");
  const reg = deps.io.loadRegistry();
  const next = upsertRegistry(reg, dir, undefined, deps.io.canonicalize);
  deps.io.saveRegistry(next);
  deps.io.writeLock(dir);
  const main = deps.io.readMain(dir);
  if (main && main.trim()) deps.store.setCode(main);
  deps.log("info", "server", `project_create ${dir} (${outcome})`);
  const output = { path: dir, created: outcome === "created", current: deps.resolveProject() };
  return pack(output);
}

export async function runProjectOpen(
  deps: ToolsDeps,
  args: ProjectOpenArgs,
): Promise<ToolResult<{ path: string; current: string | null }>> {
  const { path: p } = args;
  const dir = deps.io.canonicalize(p);
  if (!deps.io.dirExists(dir)) throw new Error("dossier introuvable");
  if (!deps.io.mainExists(dir)) {
    throw new Error("dossier sans main.tsx : refuse d'ouvrir");
  }
  // Disque source de vérité : circuit.json recréé si absent, migré
  // si legacy, erreur visible si corrompu (ticket #38).
  deps.io.ensureCircuitFile(dir);
  const reg = deps.io.loadRegistry();
  const next = upsertRegistry(reg, dir, undefined, deps.io.canonicalize);
  deps.io.saveRegistry(next);
  deps.io.writeLock(dir);
  const main = deps.io.readMain(dir);
  if (main && main.trim()) deps.store.setCode(main);
  deps.log("info", "server", `project_open ${dir}`);
  const output = { path: dir, current: deps.resolveProject() };
  return pack(output);
}

export async function runProjectClose(
  deps: ToolsDeps,
): Promise<ToolResult<{ current: string | null }>> {
  deps.io.writeLock(null);
  deps.log("info", "server", "project_close → Accueil");
  const output = { current: deps.resolveProject() };
  return pack(output);
}

export async function runPcbState(deps: ToolsDeps, args: PcbStateArgs): Promise<
  ToolResult<{
    sessionId: string;
    board: string;
    ready: boolean;
    compile: { status: string; errors: number; warnings: number };
    drc: { violations: number };
    protocolVersion: string;
  }>
> {
  const sessionId = args.session_id ?? "default";
  const proj = deps.resolveProject();
  if (!proj) {
    const err = noProjectError("pcb_state");
    const output = {
      sessionId,
      board: "",
      ready: false,
      compile: { status: "error", errors: 1, warnings: 0 },
      drc: { violations: 0 },
      protocolVersion: PROTOCOL_VERSION,
    };
    return pack(output, { ...err });
  }
  const output = deps.store.getBoardState(deps.boardName(), sessionId);
  return pack(output);
}

export async function runLogsRead(deps: ToolsDeps, args: LogsReadArgs): Promise<
  ToolResult<{
    entries: unknown[];
    nextCursor: string;
    hasMore: boolean;
    newErrors: number;
  }>
> {
  if (!deps.resolveProject()) {
    const err = noProjectError("logs_read");
    const output = { entries: [], nextCursor: "", hasMore: false, newErrors: 1 };
    return pack(output, { ...err });
  }
  const output = deps.store.readLogs({ cursor: args.cursor, limit: args.limit, level: args.level });
  return pack(output);
}

/** Ressource hiérarchie (miroir lecture) : payload JSON textuel. */
export function readHierarchy(deps: ToolsDeps): { json: unknown; text: string } {
  const proj = deps.resolveProject();
  const json = proj ? getHierarchyCore(deps.boardName()) : { error: NO_PROJECT_OPEN };
  return { json, text: JSON.stringify(json) };
}

export async function runCodePatch(
  deps: ToolsDeps,
  args: CodePatchArgs,
): Promise<ToolResult<z.infer<typeof CodePatchOutput>>> {
  const sessionId = args.session_id ?? "default";
  // Confinement (#42) : écriture refusée hors Registre.
  const { proj, scopeErr } = requireConfinedProject("code_patch", deps);
  if (!proj || scopeErr) {
    const err = scopeErr ?? noProjectError("code_patch");
    const output = {
      sessionId,
      applied: false as const,
      ready: false,
      stats: emptyStats(),
      diagnostics: [{ severity: "error", message: err.message, source: "code_patch" }],
      mode: "refuse",
      banner: null as string | null,
      errors: 1,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
    };
    return pack(output, { ...err });
  }
  const patched = applyAnchoredPatch(deps.store.getCode(), args.anchor, args.replacement);
  if (!patched.ok) {
    const output = {
      sessionId,
      applied: false as const,
      ready: deps.store.getBoardState(deps.boardName(), sessionId).ready,
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
    deps.log("error", "compile", `code_patch rejeté : ${patched.message}`);
    return pack(output);
  }
  const compiled = await deps.compile(patched.code, { disableCdnLoading: args.disableCdnLoading });
  deps.store.setLastCompile({
    status: compiled.errors === 0 ? "ok" : "error",
    errors: compiled.errors,
    warnings: compiled.warnings,
  });
  if (compiled.errors === 0) {
    try {
      // `setCode` suit la persistance réussie : sur disque KO la
      // mémoire reste égale au disque (source de vérité).
      deps.persist(proj, patched.code, compiled.circuitJson);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.log("error", "compile", `code_patch disque KO : ${message}`);
      const output = {
        sessionId,
        applied: false as const,
        ready: false,
        stats: compiled.stats,
        diagnostics: [{ severity: "error", message, source: "code_patch" }],
        mode: "echec",
        banner: compiled.banner,
        errors: 1,
        warnings: compiled.warnings,
        circuitJsonLength: 0,
        circuitJson: [] as unknown[],
      };
      return pack(output);
    }
    deps.store.setCode(patched.code);
    deps.log(
      "info",
      "compile",
      `code_patch ok : ${compiled.stats.total} éléments, 0 erreur`,
    );
  } else {
    deps.store.setCode(patched.code);
    deps.log(
      "error",
      "compile",
      `code_patch compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
    );
  }
  const output = {
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
  };
  return pack(output);
}

export async function runChecks(
  deps: ToolsDeps,
  args: RunChecksArgs,
): Promise<ToolResult<z.infer<typeof RunChecksOutput>>> {
  const checks = deps.checks ?? {
    runPlacementGate: coreRunPlacementGate,
    runDomainChecks: coreRunDomainChecks,
  };
  const proj0 = deps.resolveProject();
  if (!proj0) {
    const err = noProjectError("run_checks");
    const output = {
      sessionId: args.session_id ?? "default",
      domain: args.domain ?? "all",
      placementGreen: false,
      routingAllowed: false,
      blockReason: err.message,
      counts: { netlist: 0, placement: 0, routing: 0, style: 0, total: 0 },
      violations: [],
      errors: 1,
      warnings: 0,
    };
    return pack(output, { ...err });
  }
  const sessionId = args.session_id ?? "default";
  const asked: CheckDomain = args.domain ?? "all";
  const code = deps.store.getCode();
  const compiled = await deps.compile(code, { disableCdnLoading: args.disableCdnLoading });
  // Runner en échec (exception) → pas de circuit-json exploitable.
  // Les erreurs embarquées (soft) n'empêchent pas le gate (#39 : gate
  // placement inchangé, évalué sur le circuit-json réel).
  if (compiled.mode === "echec") {
    const output = {
      sessionId,
      domain: asked,
      placementGreen: false,
      routingAllowed: false,
      blockReason: `compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"} — corrigez via code_patch avant tout check`,
      counts: { netlist: 0, placement: 0, routing: 0, style: 0, total: 0 },
      violations: [],
      errors: 1,
      warnings: 0,
    };
    deps.log("error", "drc", `run_checks ${asked} impossible : compile en erreur`);
    return pack(output);
  }
  const gate = await checks.runPlacementGate(compiled.circuitJson, code);
  // Gate dur : aucun routing tant que le placement n'est pas vert.
  if (asked === "routing" && !gate.routingAllowed) {
    const output = {
      sessionId,
      domain: asked,
      placementGreen: gate.placementGreen,
      routingAllowed: false,
      blockReason: gate.blockReason,
      counts: {
        netlist: 0,
        placement: gate.placementViolations.length,
        routing: 0,
        style: 0,
        total: gate.placementViolations.length,
      },
      violations: gate.placementViolations,
      errors: 1,
      warnings: 0,
    };
    deps.store.setDrcViolations(gate.placementViolations.length);
    deps.log("error", "drc", `run_checks routing refusé : ${gate.blockReason ?? "placement non vert"}`);
    return pack(output);
  }
  let violations = await checks.runDomainChecks(compiled.circuitJson, asked);
  // Gate dur (#39) : domain=all ne fournit plus de routage quand le
  // routage est interdit (placement non vert). Gate placement inchangé.
  if (asked === "all" && !gate.routingAllowed) {
    violations = violations.filter((v) => v.domain !== "routing");
  }
  const counts = {
    netlist: violations.filter((v) => v.domain === "netlist").length,
    placement: violations.filter((v) => v.domain === "placement").length,
    routing: violations.filter((v) => v.domain === "routing").length,
    style: violations.filter((v) => v.domain === "style").length,
    total: violations.length,
  };
  deps.store.setDrcViolations(counts.total);
  deps.log(
    violations.length === 0 ? "info" : "warn",
    "drc",
    `run_checks ${asked} : ${violations.length} violation(s), placement ${gate.placementGreen ? "vert" : "rouge"}`,
  );
  const output = {
    sessionId,
    domain: asked,
    placementGreen: gate.placementGreen,
    routingAllowed: gate.routingAllowed,
    blockReason: gate.blockReason,
    counts,
    violations,
    // Compteurs réels (#39) : erreurs/warnings embarqués du circuit-json.
    errors: compiled.errors,
    warnings: compiled.warnings,
  };
  return pack(output);
}

/** Mutations write-through sérialisées par la file (hors lectures). */
export function liveOpNeedsQueue(op: string): boolean {
  const asked = (op ?? "").trim();
  return asked === "move" || asked === "rotate" || asked === "swap_package" || asked === "reassign_net";
}

export async function runLiveManage(
  deps: ToolsDeps,
  args: LiveManageArgs,
): Promise<ToolResult<z.infer<typeof LiveManageOutput>>> {
  // Confinement (#42) : lecture/écriture refusées hors Registre.
  const { proj: projLive, scopeErr: scopeErrLive } = requireConfinedProject("live_manage", deps);
  if (!projLive || scopeErrLive) {
    const err = scopeErrLive ?? noProjectError("live_manage");
    const output = {
      sessionId: args.session_id ?? "default",
      op: (args.op ?? "").trim(),
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
    };
    return pack(output, { ...err });
  }
  const sessionId = args.session_id ?? "default";
  const asked = (args.op ?? "").trim();

  const refused = (REFUSED_LIVE_OPS as readonly string[]).includes(asked);
  if (refused || asked === "create") {
    const message = refuseLiveCreation(asked || "create");
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    const output = {
      sessionId,
      op: asked,
      applied: false as const,
      ready,
      stats: emptyStats(),
      diagnostics: [{ severity: "error", message, source: "live_manage" }],
      mode: "refuse",
      banner: null as string | null,
      errors: 1,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: null as string | null,
      selection: null,
      views: null as string[] | null,
      message,
    };
    deps.log("error", "compile", `live_manage ${asked} refusé : ${message}`);
    return pack(output);
  }

  if (asked === "select") {
    if (!args.refdes) {
      const message = "select exige refdes (ex R1)";
      const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
      const output = {
        sessionId,
        op: asked,
        applied: false as const,
        ready,
        stats: emptyStats(),
        diagnostics: [{ severity: "error", message, source: "live_manage" }],
        mode: "refuse",
        banner: null as string | null,
        errors: 1,
        warnings: 0,
        circuitJsonLength: 0,
        circuitJson: [] as unknown[],
        code: deps.store.getCode(),
        selection: null,
        views: null as string[] | null,
        message,
      };
      return pack(output);
    }
    const selection = getSelection(deps.store.getCode(), args.refdes);
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    if (!selection) {
      const message = `composant ${args.refdes} introuvable dans le TSX`;
      const output = {
        sessionId,
        op: asked,
        applied: false as const,
        ready,
        stats: emptyStats(),
        diagnostics: [{ severity: "error", message, source: "live_manage" }],
        mode: "lecture",
        banner: null as string | null,
        errors: 1,
        warnings: 0,
        circuitJsonLength: 0,
        circuitJson: [] as unknown[],
        code: deps.store.getCode(),
        selection: null,
        views: null as string[] | null,
        message,
      };
      return pack(output);
    }
    const output = {
      sessionId,
      op: asked,
      applied: true as const,
      ready,
      stats: emptyStats(),
      diagnostics: [],
      mode: "lecture",
      banner: null as string | null,
      errors: 0,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: deps.store.getCode(),
      selection,
      views: null as string[] | null,
      message: null as string | null,
    };
    return pack(output);
  }

  if (asked === "view") {
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    const views = listViews();
    const output = {
      sessionId,
      op: asked,
      applied: true as const,
      ready,
      stats: emptyStats(),
      diagnostics: [],
      mode: "lecture",
      banner: null as string | null,
      errors: 0,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: deps.store.getCode(),
      selection: null,
      views,
      message: null as string | null,
    };
    return pack(output);
  }

  // Mutations (l'adaptateur sérialise via la file).
  const code = deps.store.getCode();
  let mutated: { ok: true; code: string } | { ok: false; message: string };
  switch (asked) {
    case "move":
      if (args.x === undefined || args.y === undefined) {
        mutated = { ok: false as const, message: "move exige x et y (nombres, mm)" };
      } else {
        mutated = applyMove(code, args.refdes ?? "", args.x, args.y);
      }
      break;
    case "rotate":
      if (args.degrees === undefined) {
        mutated = { ok: false as const, message: "rotate exige degrees (nombre)" };
      } else {
        mutated = applyRotate(code, args.refdes ?? "", args.degrees);
      }
      break;
    case "swap_package":
      if (!args.footprint) {
        mutated = { ok: false as const, message: "swap_package exige footprint (ex 0603)" };
      } else {
        mutated = applySwapPackage(code, args.refdes ?? "", args.footprint);
      }
      break;
    case "reassign_net":
      if (!args.pin || !args.net) {
        mutated = { ok: false as const, message: "reassign_net exige pin et net (ex pin1, GND)" };
      } else {
        mutated = applyReassignNet(code, args.refdes ?? "", args.pin, args.net);
      }
      break;
    default: {
      const message =
        `op live "${asked}" inconnue (live V1 : move | rotate | swap_package | reassign_net + select/view) — ` +
        `création/suppression via code_patch`;
      const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
      const output = {
        sessionId,
        op: asked,
        applied: false as const,
        ready,
        stats: emptyStats(),
        diagnostics: [{ severity: "error", message, source: "live_manage" }],
        mode: "refuse",
        banner: null as string | null,
        errors: 1,
        warnings: 0,
        circuitJsonLength: 0,
        circuitJson: [] as unknown[],
        code: null as string | null,
        selection: null,
        views: null as string[] | null,
        message,
      };
      deps.log("error", "compile", `live_manage ${asked} inconnu`);
      return pack(output);
    }
  }
  if (!mutated.ok) {
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    const output = {
      sessionId,
      op: asked,
      applied: false as const,
      ready,
      stats: emptyStats(),
      diagnostics: [
        { severity: "error", message: mutated.message, source: "live_manage" },
      ],
      mode: "refuse",
      banner: null as string | null,
      errors: 1,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: null as string | null,
      selection: null,
      views: null as string[] | null,
      message: mutated.message,
    };
    deps.log("error", "compile", `live_manage ${asked} rejeté : ${mutated.message}`);
    return pack(output);
  }
  const compiled = await deps.compile(mutated.code, { disableCdnLoading: args.disableCdnLoading });
  const ready = compiled.errors === 0;
  deps.store.setLastCompile({
    status: compiled.errors === 0 ? "ok" : "error",
    errors: compiled.errors,
    warnings: compiled.warnings,
  });
  if (compiled.errors === 0) {
    try {
      // `setCode` suit la persistance réussie (cf. code_patch).
      deps.persist(projLive, mutated.code, compiled.circuitJson);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.log("error", "compile", `live_manage disque KO : ${message}`);
      const output = {
        sessionId,
        op: asked,
        applied: false as const,
        ready: false,
        stats: compiled.stats,
        diagnostics: [{ severity: "error", message, source: "live_manage" }],
        mode: "echec",
        banner: compiled.banner,
        errors: 1,
        warnings: compiled.warnings,
        circuitJsonLength: 0,
        circuitJson: [] as unknown[],
        code: mutated.code,
        selection: null,
        views: null as string[] | null,
        message,
      };
      return pack(output);
    }
    deps.store.setCode(mutated.code);
    deps.log("info", "compile", `live_manage ${asked} ok : ${compiled.stats.total} éléments, 0 erreur`);
  } else {
    // Compile en erreur : mémoire à jour (sonnette pcb_state), disque
    // inchangé, diagnostics exploitables — comportement inchangé.
    deps.store.setCode(mutated.code);
    deps.log(
      "error",
      "compile",
      `live_manage ${asked} compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
    );
  }
  const output = {
    sessionId,
    op: asked,
    applied: true as const,
    ready,
    stats: compiled.stats,
    diagnostics: compiled.diagnostics,
    mode: compiled.mode,
    banner: compiled.banner,
    errors: compiled.errors,
    warnings: compiled.warnings,
    circuitJsonLength: compiled.circuitJson.length,
    circuitJson: compiled.circuitJson,
    code: mutated.code,
    selection: null,
    views: null as string[] | null,
    message: null as string | null,
  };
  return pack(output);
}

export async function runPreviewScreenshot(
  deps: ToolsDeps,
  args: PreviewScreenshotArgs,
): Promise<ToolResult<z.infer<typeof PreviewScreenshotOutput>>> {
  const sessionId = args.session_id ?? "default";
  // Confinement (#42) : lecture capture refusée hors Registre
  // (sans repli vers le cache global — un projet ouvert hors périmètre
  // ne doit ni lire son dossier ni fuir vers un autre).
  const { proj: projPrev, scopeErr: scopeErrPrev } = requireConfinedProject("preview_screenshot", deps);
  if (scopeErrPrev) {
    const output = {
      sessionId,
      source: String(args.source ?? ""),
      name: (typeof args.name === "string" ? args.name : null) as string | null,
      found: false,
      dataUrl: null,
      bytes: 0,
      width: null,
      height: null,
      previewUrl: null,
      updatedAt: null,
      banner: null,
      message: scopeErrPrev.message,
      errors: 1,
      warnings: 0,
    };
    return pack(output, { ...scopeErrPrev });
  }
  // Priorité <Projet ouvert>/previews/, fallback override tests / cache global.
  // `PCB_MCP_PREVIEW_DIR` est un hook de TEST (revue #37 item 4) : jamais
  // posé par le backend prod, non contrôlable via MCP.
  const previewOverride = deps.preview.previewFallbackDir();
  const projectDir = deps.preview.previewDirFor(projPrev);
  const previewDirEff = projectDir || previewOverride;
  if (!previewDirEff) {
    const err = noProjectError("preview_screenshot");
    const output = {
      sessionId,
      source: String(args.source ?? ""),
      name: (typeof args.name === "string" ? args.name : null) as string | null,
      found: false,
      dataUrl: null,
      bytes: 0,
      width: null,
      height: null,
      previewUrl: null,
      updatedAt: null,
      banner: null,
      message: err.message,
      errors: 1,
      warnings: 0,
    };
    return pack(output, { ...err });
  }
  let read = deps.preview.readPreview(args.source ?? "", {
    dir: previewDirEff,
    disableCdnLoading: args.disableCdnLoading,
    name: args.name,
  });
  if (!read.found && previewOverride && previewOverride !== previewDirEff) {
    read = deps.preview.readPreview(args.source ?? "", {
      dir: previewOverride,
      disableCdnLoading: args.disableCdnLoading,
      name: args.name,
    });
  }
  if (read.found) {
    deps.log("info", "export", `preview_screenshot ${read.source} ok : ${read.bytes} octets`);
  } else {
    deps.log("warn", "export", `preview_screenshot ${String(args.source)} introuvable : ${read.message ?? "inconnu"}`);
  }
  const output = {
    sessionId,
    source: String(read.source),
    name: read.name,
    found: read.found,
    dataUrl: read.dataUrl,
    bytes: read.bytes,
    width: read.width,
    height: read.height,
    previewUrl: read.previewUrl,
    updatedAt: read.updatedAt,
    banner: read.banner,
    message: read.message,
    errors: read.errors,
    warnings: read.warnings,
  };
  return pack(output);
}

export async function runBatchExecute(
  deps: ToolsDeps,
  args: BatchExecuteArgs,
): Promise<ToolResult<z.infer<typeof BatchExecuteOutput>>> {
  const checks = deps.checks ?? {
    runPlacementGate: coreRunPlacementGate,
    runDomainChecks: coreRunDomainChecks,
  };
  const sessionId = args.session_id ?? "default";
  // Confinement (#42) : lot refusé hors Registre.
  const { proj: projBatch, scopeErr: scopeErrBatch } = requireConfinedProject("batch_execute", deps);
  if (!projBatch || scopeErrBatch) {
    const err = scopeErrBatch ?? noProjectError("batch_execute");
    const output = {
      sessionId,
      applied: false as const,
      ready: false,
      failedOpIndex: null as number | null,
      rolledBack: false,
      stats: emptyStats(),
      diagnostics: [{ severity: "error", message: err.message, source: "batch_execute" }],
      mode: "refuse",
      banner: null as string | null,
      errors: 1,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: null as string | null,
    };
    return pack(output, { ...err });
  }
  const ops = (args.operations ?? []) as BatchOp[];
  if (!Array.isArray(ops) || ops.length === 0) {
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    const output = {
      sessionId,
      applied: false as const,
      ready,
      failedOpIndex: null as number | null,
      rolledBack: false,
      stats: emptyStats(),
      diagnostics: [
        {
          severity: "error",
          message: "lot vide : fournissez au moins une opération",
          source: "batch_execute",
        },
      ],
      mode: "refuse",
      banner: null as string | null,
      errors: 1,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: null as string | null,
    };
    deps.log("error", "compile", "batch_execute rejeté : lot vide");
    return pack(output);
  }
  const snap = deps.store.snapshot();
  const batched = applyBatch(snap.code, ops);
  if (!batched.ok) {
    deps.store.restore(snap);
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    const output = {
      sessionId,
      applied: false as const,
      ready,
      failedOpIndex: batched.failedIndex as number | null,
      rolledBack: true,
      stats: emptyStats(),
      diagnostics: [
        { severity: "error", message: batched.message, source: "batch_execute" },
      ],
      mode: "echec",
      banner: null as string | null,
      errors: 1,
      warnings: 0,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: snap.code,
    };
    deps.log(
      "error",
      "compile",
      `batch_execute rollback : op ${batched.failedIndex} — ${batched.message}`,
    );
    return pack(output);
  }
  deps.store.setCode(batched.code);
  const compiled = await deps.compile(batched.code, { disableCdnLoading: args.disableCdnLoading });
  if (compiled.errors !== 0) {
    deps.store.restore(snap);
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    const output = {
      sessionId,
      applied: false as const,
      ready,
      failedOpIndex: null as number | null,
      rolledBack: true,
      stats: emptyStats(),
      diagnostics: compiled.diagnostics,
      mode: "echec",
      banner: compiled.banner,
      errors: compiled.errors,
      warnings: compiled.warnings,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: snap.code,
    };
    deps.log(
      "error",
      "compile",
      `batch_execute rollback : compile en erreur — ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
    );
    return pack(output);
  }
  // Gate route (#44) : si le lot contient une op `route`, la compile
  // verte ne suffit pas — le placement doit être vert (sinon le
  // moteur ignore l'autoroutage) et le circuit-json doit être
  // effectivement routé. Sinon rollback, état inchangé.
  if (ops.some((o) => o.kind === "route")) {
    const gate = await checks.runPlacementGate(compiled.circuitJson, batched.code);
    const blockReason = !gate.routingAllowed
      ? (gate.blockReason ?? "placement non vert")
      : !isBoardRouted(compiled.circuitJson)
        ? "board non routé : aucune pcb_trace avec route dans le circuit-json — vérifiez le placement puis relancez"
        : null;
    if (blockReason) {
      deps.store.restore(snap);
      const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
      const output = {
        sessionId,
        applied: false as const,
        ready,
        failedOpIndex: null as number | null,
        rolledBack: true,
        stats: emptyStats(),
        diagnostics: [
          { severity: "error", message: `routing refusé : ${blockReason}`, source: "batch_execute" },
        ],
        mode: "echec",
        banner: compiled.banner,
        errors: 1,
        warnings: compiled.warnings,
        circuitJsonLength: 0,
        circuitJson: [] as unknown[],
        code: snap.code,
      };
      deps.log(
        "error",
        "compile",
        `batch_execute rollback : routing refusé — ${blockReason}`,
      );
      return pack(output);
    }
  }
  deps.store.setLastCompile({ status: "ok", errors: 0, warnings: compiled.warnings });
  deps.log(
    "info",
    "compile",
    `batch_execute ok : ${ops.length} ops, ${compiled.stats.total} éléments, 0 erreur`,
  );
  try {
    deps.persist(projBatch, batched.code, compiled.circuitJson);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log("error", "compile", `batch_execute disque KO : ${message}`);
    deps.store.restore(snap);
    const ready = deps.store.getBoardState(deps.boardName(), sessionId).ready;
    const output = {
      sessionId,
      applied: false as const,
      ready,
      failedOpIndex: null as number | null,
      rolledBack: true,
      stats: compiled.stats,
      diagnostics: [{ severity: "error", message, source: "batch_execute" }],
      mode: "echec",
      banner: compiled.banner,
      errors: 1,
      warnings: compiled.warnings,
      circuitJsonLength: 0,
      circuitJson: [] as unknown[],
      code: snap.code,
    };
    return pack(output);
  }
  const output = {
    sessionId,
    applied: true as const,
    ready: true,
    failedOpIndex: null as number | null,
    rolledBack: false,
    stats: compiled.stats,
    diagnostics: compiled.diagnostics,
    mode: compiled.mode,
    banner: compiled.banner,
    errors: 0,
    warnings: compiled.warnings,
    circuitJsonLength: compiled.circuitJson.length,
    circuitJson: compiled.circuitJson,
    code: batched.code,
  };
  return pack(output);
}

export async function runSearchParts(
  deps: ToolsDeps,
  args: SearchPartsArgs,
): Promise<ToolResult<z.infer<typeof SearchPartsOutput>>> {
  // Confinement (#42, revue #37 item 3) : comme les 5 autres outils,
  // search_parts exige un Projet membre du Registre.
  const { proj: projSp, scopeErr: scopeErrSp } = requireConfinedProject("search_parts", deps);
  if (!projSp || scopeErrSp) {
    const err = scopeErrSp ?? noProjectError("search_parts");
    const output = {
      sessionId: args.session_id ?? "default",
      query: (args.query ?? "").trim(),
      source: (args.source ?? "jlcpcb").trim().toLowerCase(),
      tsciSearch: "",
      results: [],
      banner: null as string | null,
      message: err.message,
      errors: 1,
      warnings: 0,
    };
    return pack(output, { ...err });
  }
  const sessionId = args.session_id ?? "default";
  const src = (args.source ?? "jlcpcb").trim().toLowerCase();
  if (src !== "jlcpcb" && src !== "lcsc") {
    const message =
      `source "${args.source}" non supportée au MVP (sourcing JLCPCB-first, décision carte #6) : ` +
      `multi-sourcing (DigiKey/Mouser/Farnell) différé V2 — utilisez source=jlcpcb (ou alias lcsc)`;
    deps.log("error", "export", `search_parts source refusée : ${args.source}`);
    const output = {
      sessionId,
      query: (args.query ?? "").trim(),
      source: src,
      tsciSearch: `tsci search --jlcpcb "${(args.query ?? "").trim()}"`,
      results: [],
      banner: null as string | null,
      message,
      errors: 1,
      warnings: 0,
    };
    return pack(output);
  }
  const found = await searchPartsCore(args.query ?? "", {
    limit: args.limit ?? 5,
    disableCdnLoading: args.disableCdnLoading,
    fetchFn: deps.fetchFn,
  });
  if (!found.ok) {
    deps.log("error", "export", `search_parts "${args.query ?? ""}" impossible : ${found.message}`);
    const output = {
      sessionId,
      query: found.query,
      source: src,
      tsciSearch: found.tsciSearch,
      results: [],
      banner: found.banner,
      message: found.message,
      errors: 1,
      warnings: 0,
    };
    return pack(output);
  }
  deps.log(
    "info",
    "export",
    `search_parts "${found.query}" : ${found.results.length} résultat(s) JLCPCB`,
  );
  const output = {
    sessionId,
    query: found.query,
    source: src,
    tsciSearch: found.tsciSearch,
    results: found.results,
    banner: null as string | null,
    message: found.message,
    errors: 0,
    warnings: 0,
  };
  return pack(output);
}

export async function runFabExport(
  deps: ToolsDeps,
  args: FabExportArgs,
): Promise<ToolResult<z.infer<typeof FabExportOutput>>> {
  const checks = deps.checks ?? {
    runPlacementGate: coreRunPlacementGate,
    runDomainChecks: coreRunDomainChecks,
  };
  // Confinement (#42) : export refusé hors Registre.
  const { proj: projFab, scopeErr: scopeErrFab } = requireConfinedProject("fab_export", deps);
  if (!projFab || scopeErrFab) {
    const err = scopeErrFab ?? noProjectError("fab_export");
    const output = {
      sessionId: args.session_id ?? "default",
      ready: false as const,
      mode: "refuse",
      banner: null as string | null,
      errors: 1,
      warnings: 0,
      counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
      gerberNames: [],
      gerberPreview: "",
      bomCsv: "",
      pnpCsv: "",
      kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
      kicadZip: { bytes: 0, previewUrl: "" },
      fabZip: { bytes: 0, previewUrl: "" },
      artifacts: [],
      exportDir: "",
      message: err.message,
    };
    return pack(output, { ...err });
  }
  const sessionId = args.session_id ?? "default";
  const code = deps.store.getCode();
  const compiled = await deps.compile(code, { disableCdnLoading: args.disableCdnLoading });
  // Sortie vide partagée des 3 gates de refus (revue #37 item 11) : les
  // CONDITIONS des gates (#39/#44) sont inchangées, seule la
  // construction de la sortie est factorisée en closure nommée.
  const emptyFabOutput = (message: string) => ({
    sessionId,
    ready: false as const,
    mode: "refuse" as const,
    banner: compiled.banner,
    errors: 1,
    warnings: 0,
    counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
    gerberNames: [],
    gerberPreview: "",
    bomCsv: "",
    pnpCsv: "",
    kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
    kicadZip: { bytes: 0, previewUrl: "" },
    fabZip: { bytes: 0, previewUrl: "" },
    artifacts: [],
    exportDir: "",
    message,
  });
  // Runner en échec (exception) → aucun circuit-json : pas de gate.
  if (compiled.mode === "echec") {
    deps.log(
      "error",
      "export",
      `fab_export impossible : compile en erreur — ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
    );
    const output = {
      sessionId,
      ready: false as const,
      mode: "echec",
      banner: compiled.banner,
      errors: compiled.errors,
      warnings: compiled.warnings,
      counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
      gerberNames: [],
      gerberPreview: "",
      bomCsv: "",
      pnpCsv: "",
      kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
      kicadZip: { bytes: 0, previewUrl: "" },
      fabZip: { bytes: 0, previewUrl: "" },
      artifacts: [],
      exportDir: "",
      message: `compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"} — corrigez via code_patch avant tout export`,
    };
    return pack(output);
  }
  // Gate board routé (#44) : le routage déclaré interdit
  // (`routingDisabled`) est refusé avec un message explicite avant le
  // gate DRC (dont le décompte générique masquerait la cause).
  // L'export sort d'un board routé par l'autorouteur local.
  if (boardRoutingDisabled(code)) {
    const reason =
      "routingDisabled déclaré sur <board> — retirez-le via code_patch et routez (batch_execute route) avant tout export";
    deps.log("error", "export", `fab_export refusé : board non routé — ${reason}`);
    const output = emptyFabOutput(`board non routé : ${reason}`);
    return pack(output);
  }
  // Gate DRC obligatoire avant export (#39) : placement vert exigé et
  // zéro violation tous domaines (routing exclu si interdit, comme run_checks).
  const gate = await checks.runPlacementGate(compiled.circuitJson, code);
  const allViolations = await checks.runDomainChecks(compiled.circuitJson, "all");
  const drcViolations = gate.routingAllowed
    ? allViolations
    : allViolations.filter((v) => v.domain !== "routing");
  if (!gate.placementGreen || drcViolations.length > 0) {
    const reason =
      gate.blockReason ?? `${drcViolations.length} violation(s) DRC à corriger`;
    deps.store.setDrcViolations(drcViolations.length);
    deps.log("error", "export", `fab_export refusé : DRC rouge — ${reason}`);
    const output = emptyFabOutput(
      `DRC rouge : ${reason} — corrigez via code_patch/run_checks avant tout export`,
    );
    return pack(output);
  }
  deps.store.setDrcViolations(0);
  // Preuve de routage effectif (#44, résiduel après gate DRC) : des
  // `<trace>` déclarées mais aucune `pcb_trace` routée (autoroutage
  // ignoré) → export refusé, jamais de gerbers sans cuivre.
  if (boardExpectsRouting(code) && !isBoardRouted(compiled.circuitJson)) {
    const reason =
      "aucune trace routée dans le circuit-json — routez via batch_execute (op route) avant tout export";
    deps.log("error", "export", `fab_export refusé : board non routé — ${reason}`);
    const output = emptyFabOutput(`board non routé : ${reason}`);
    return pack(output);
  }
  // Erreurs embarquées résiduelles (gate vert, checks verts, mais
  // circuit-json en erreur : ex empreinte invalide) → export refusé
  // comme une compile en erreur, jamais de gerbers inventés.
  if (compiled.errors > 0) {
    deps.log(
      "error",
      "export",
      `fab_export impossible : compile en erreur — ${compiled.diagnostics.find((d) => d.severity === "error")?.message ?? "inconnu"}`,
    );
    const output = {
      sessionId,
      ready: false as const,
      mode: "echec",
      banner: compiled.banner,
      errors: compiled.errors,
      warnings: compiled.warnings,
      counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
      gerberNames: [],
      gerberPreview: "",
      bomCsv: "",
      pnpCsv: "",
      kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
      kicadZip: { bytes: 0, previewUrl: "" },
      fabZip: { bytes: 0, previewUrl: "" },
      artifacts: [],
      exportDir: "",
      message: `compile en erreur : ${compiled.diagnostics.find((d) => d.severity === "error")?.message ?? "inconnu"} — corrigez via code_patch avant tout export`,
    };
    return pack(output);
  }
  const fab = await exportFab(compiled.circuitJson as unknown[], {
    projectName: deps.fab.projectNameForExport(projFab, args.project_name),
  });
  if (!fab.ok) {
    deps.log("error", "export", `fab_export impossible : ${fab.message}`);
    const output = {
      sessionId,
      ready: false as const,
      mode: "echec",
      banner: compiled.banner,
      errors: 1,
      warnings: 0,
      counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
      gerberNames: [],
      gerberPreview: "",
      bomCsv: "",
      pnpCsv: "",
      kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
      kicadZip: { bytes: 0, previewUrl: "" },
      fabZip: { bytes: 0, previewUrl: "" },
      artifacts: [],
      exportDir: "",
      message: fab.message,
    };
    return pack(output);
  }
  const out = fab as FabOk;
  const dir = deps.fab.resolveExportDir(projFab, out.projectName, sessionId);
  deps.fab.mkdirp(dir);
  deps.fab.mkdirp(deps.fab.joinPath(dir, "gerbers"));
  const artifacts = writeFabArtifacts(out, {
    dir,
    writeFile: deps.fab.writeFile,
    toFileUrl: deps.fab.toFileUrl,
    join: deps.fab.joinPath,
  });
  const byName = (n: string) => artifacts.find((a) => a.name === n);
  deps.log(
    "info",
    "export",
    `fab_export ok : ${out.counts.gerberFiles} gerbers, BOM ${out.counts.bomRows} lignes, PnP ${out.counts.pnpRows} lignes, kicad silencieux → ${dir}`,
  );
  const output = {
    sessionId,
    ready: true as const,
    mode: compiled.mode,
    banner: compiled.banner,
    errors: 0,
    warnings: compiled.warnings,
    counts: out.counts,
    gerberNames: out.gerberNames,
    gerberPreview: out.gerberPreview,
    bomCsv: out.bomCsv,
    pnpCsv: out.pnpCsv,
    kicad: {
      pcbBytes: Buffer.byteLength(out.kicadPcb),
      schBytes: Buffer.byteLength(out.kicadSch),
      proBytes: Buffer.byteLength(out.kicadPro),
      pcbPreview: out.kicadPcbPreview,
    },
    kicadZip: {
      bytes: out.kicadZipBytes,
      previewUrl: byName("kicad_project.zip")?.previewUrl ?? "",
    },
    fabZip: {
      bytes: out.fabZipBytes,
      previewUrl: byName("fab_upload.zip")?.previewUrl ?? "",
    },
    artifacts,
    exportDir: dir,
    message: null as string | null,
  };
  return pack(output);
}
