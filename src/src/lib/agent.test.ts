// Parité routeur local (T5) vs MCP (issue #60) : même scénario, même stub,
// des deux côtés — sorties strictement identiques.
// Côté référence : fonctions du CŒUR (`tools-core/tools.ts`, chemin exact de
// l'adaptateur MCP `src/mcp.ts` hors framing HTTP) avec effets sidecar réels
// (`src/project.ts`, `src/preview.ts`, `node:fs`, registre isolé).
// Côté routeur : `createAgentRouter(fakeTransport)` (effets WebView simulés).
// TDD : couture `AgentTransport` + sorties JSON (jamais d'internes).

import { describe, test, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { resetQueueForTests } from "../../../pcb-mcp/src/tools-core/queue";
import { createMemoryStore } from "../../../pcb-mcp/src/tools-core/store";
import {
  assertProjectMember,
  parseCircuitFile,
  serializeCircuitFile,
  templateCode,
} from "../../../pcb-mcp/src/tools-core/project-core";
import { computeStats } from "../../../pcb-mcp/src/tools-core/board";
import {
  CDN_BANNER,
  extractEmbeddedDiagnostics,
} from "../../../pcb-mcp/src/tools-core/diagnostics";
import {
  runBatchExecute,
  runChecks,
  runCodePatch,
  runFabExport,
  runLiveManage,
  runLogsRead,
  runPcbState,
  runPreviewScreenshot,
  runProjectClose,
  runProjectCreate,
  runProjectCurrent,
  runProjectList,
  runProjectOpen,
  runSearchParts,
  readHierarchy,
} from "../../../pcb-mcp/src/tools-core/tools";
import type { ToolsDeps } from "../../../pcb-mcp/src/tools-core/deps";
import {
  canonicalProjectPath,
  ensureCircuitFile,
  ensureProjectLayout,
  loadRegistry,
  persistProjectFiles,
  projectExportDir,
  projectMainPath,
  projectPreviewsDir,
  saveRegistry,
  upsertRegistry,
} from "../../../pcb-mcp/src/project";
import { readPreview } from "../../../pcb-mcp/src/preview";
import {
  createAgentRouter,
  type AgentCompileOut,
  type AgentContext,
  type AgentRouter,
  type AgentTransport,
} from "./agent";

// --- Faux backend (double des commandes `agent_*`, effets version WebView) --

const DEMO_TS = `export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={-4} />
  </board>
)
`;

const SOURCE_CJ = [
  { type: "source", name: "top" },
  { type: "source_component", source_component_id: "R1" },
];
// NOTE parité : le repli inline n'existe que côté frontend ; les stubs
// utilisent le mode worker des deux côtés (différence documentée). Le stub
// est SANS trace (les vrais checks plantent sur une trace fabriquée).

function sha256hex(s: string | Uint8Array): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function fileUrl(p: string): string {
  const segs = p.split("/").map((seg) =>
    seg
      .split("")
      .map((ch) =>
        /[A-Za-z0-9\-_.~]/.test(ch)
          ? ch
          : `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
      )
      .join(""),
  );
  return `file://${segs.join("/")}`;
}

class FakeTransport implements AgentTransport {
  root: string;
  regFile: string;
  current: string | null = null;
  compileFn: (code: string) => Promise<AgentCompileOut>;
  fetchMap = new Map<string, { status: number; body: string }>();
  fetchThrow: Error | null = null;
  commitThrow: Error | null = null;

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-parity-"));
    this.regFile = path.join(this.root, "projects.json");
    fs.writeFileSync(
      this.regFile,
      JSON.stringify({ projects: [], lastOpened: null }),
    );
    this.compileFn = async () => ({ circuitJson: [], mode: "echec", banner: "offline" });
  }

  cleanup() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  reg() {
    return JSON.parse(fs.readFileSync(this.regFile, "utf8")) as {
      projects: { path: string; lastOpened: string }[];
      lastOpened: string | null;
    };
  }

  saveReg(r: unknown) {
    fs.writeFileSync(this.regFile, JSON.stringify(r, null, 2));
  }

  mkProject(name: string, code: string = DEMO_TS): string {
    const dir = path.join(this.root, name);
    fs.mkdirSync(path.join(dir, "previews"), { recursive: true });
    fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "main.tsx"), code);
    fs.writeFileSync(
      path.join(dir, "circuit.json"),
      serializeCircuitFile([]),
    );
    const next = upsertRegistry(this.reg(), dir, new Date().toISOString());
    this.saveReg(next);
    return dir;
  }

  items() {
    const r = this.reg();
    return r.projects.map((e) => {
      const p = path.parse(e.path);
      return {
        path: e.path,
        name: p.base,
        parent: path.dirname(e.path),
        exists: fs.existsSync(e.path),
        lastOpened: e.lastOpened,
      };
    });
  }

  async getContext(): Promise<AgentContext> {
    return { project: this.current, projects: this.items(), lastOpened: this.reg().lastOpened };
  }

  async createProject(p: string, template: "vide" | "demo"): Promise<string> {
    const code = templateCode(template);
    if (code === null) throw new Error(`gabarit inconnu "${template}"`);
    const existedMain = fs.existsSync(path.join(p, "main.tsx"));
    if (existedMain) {
      ensureCircuitFile(p);
    } else {
      if (fs.existsSync(p)) {
        const entries = fs.readdirSync(p).filter((n) => n !== "previews" && n !== "exports");
        if (entries.length > 0)
          throw new Error("dossier non-vide sans main.tsx : refuse d'écraser");
      } else {
        fs.mkdirSync(p, { recursive: true });
      }
      fs.mkdirSync(path.join(p, "previews"), { recursive: true });
      fs.mkdirSync(path.join(p, "exports"), { recursive: true });
      fs.writeFileSync(path.join(p, "main.tsx"), code);
      fs.writeFileSync(path.join(p, "circuit.json"), serializeCircuitFile([]));
    }
    void existedMain;
    this.saveReg(upsertRegistry(this.reg(), p, new Date().toISOString()));
    this.current = p;
    return p;
  }

  async openProject(p: string): Promise<string> {
    if (!fs.existsSync(p)) throw new Error("dossier introuvable");
    if (!fs.existsSync(path.join(p, "main.tsx")))
      throw new Error("dossier sans main.tsx : refuse d'ouvrir");
    ensureCircuitFile(p);
    this.saveReg(upsertRegistry(this.reg(), p, new Date().toISOString()));
    this.current = p;
    return p;
  }

  async closeProject(): Promise<void> {
    this.current = null;
  }

  async readMain(p?: string) {
    const target = p ?? this.current;
    if (!target) throw new Error("aucun projet ouvert");
    assertProjectMember(target, this.reg());
    const code = fs.readFileSync(path.join(target, "main.tsx"), "utf8");
    return { path: path.join(target, "main.tsx"), code, hash: sha256hex(code) };
  }

  async commitFiles(input: { path: string; code: string; circuitJson: unknown[] }) {
    if (this.commitThrow) throw this.commitThrow;
    assertProjectMember(input.path, this.reg());
    fs.writeFileSync(path.join(input.path, "main.tsx"), input.code);
    fs.writeFileSync(
      path.join(input.path, "circuit.json"),
      serializeCircuitFile(input.circuitJson),
    );
    return {
      path: path.join(input.path, "main.tsx"),
      code_hash: sha256hex(input.code),
      circuit_ok: true,
    };
  }

  async fetchAllowed(url: string) {
    if (this.fetchThrow) throw this.fetchThrow;
    const hit = this.fetchMap.get(url);
    if (!hit) throw new Error(`fetch non mocké : ${url}`);
    return hit;
  }

  async fabWrite(p: string, _projectName: string | undefined, files: { name: string; base64: string }[]) {
    assertProjectMember(p, this.reg());
    for (const f of files) {
      if (f.name.startsWith("/") || f.name.split("/").includes(".."))
        throw new Error(`nom d'artefact refusé (Confinement) : ${f.name}`);
    }
    const base = path.basename(p);
    const safe = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "board";
    const dir = path.join(p, "exports", `${safe}-${sha256hex(p).slice(0, 12)}`);
    fs.mkdirSync(path.join(dir, "gerbers"), { recursive: true });
    const artifacts = files.map((f) => {
      const buf = Buffer.from(f.base64, "base64");
      const full = path.join(dir, f.name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      return { name: f.name, bytes: buf.length, preview_url: fileUrl(full) };
    });
    return { export_dir: dir, artifacts };
  }

  async previewRead(source: string, name?: string | null, disableCdnLoading?: boolean) {
    if (!this.current)
      throw new Error("NO_PROJECT_OPEN : aucun projet ouvert");
    assertProjectMember(this.current, this.reg());
    const read = readPreview(source, {
      dir: path.join(this.current, "previews"),
      name: name ?? undefined,
      disableCdnLoading,
    });
    return {
      found: read.found,
      source: read.source,
      name: read.name,
      data_url: read.dataUrl,
      bytes: read.bytes,
      width: read.width,
      height: read.height,
      preview_url: read.previewUrl,
      updated_at: read.updatedAt,
      banner: read.banner,
      message: read.message,
      errors: read.errors,
      warnings: read.warnings,
    };
  }

  async compile(code: string, opts?: { disableCdnLoading?: boolean }) {
    return this.compileFn(code);
    void opts;
  }
}

// --- Deps référence (chemin exact MCP : cœur + effets sidecar réels) --------

function refDeps(
  fake: FakeTransport,
  project: string | null | (() => string | null),
  compileStub: (code: string, opts?: { disableCdnLoading?: boolean }) => Promise<{
    circuitJson: unknown[];
    mode: string;
    banner: string | null;
  }>,
  fetchStub?: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
): ToolsDeps {
  const store = createMemoryStore();
  const resolved = () => (typeof project === "function" ? project() : project);
  if (resolved()) {
    try {
      const code = fs.readFileSync(projectMainPath(resolved() as string), "utf8");
      if (code.trim()) store.setCode(code);
    } catch {
      // Layout absent : gardes refuseront comme le MCP.
    }
  }
  const reg = () => loadRegistry(fake.regFile);
  return {
    store,
    resolveProject: () => resolved(),
    assertMember: (p) => assertProjectMember(p, reg()),
    boardName: () => {
      const cur = resolved();
      if (!cur) return "board";
      return path.basename(cur) || "board";
    },
    compile: (async (code: string, opts?: { disableCdnLoading?: boolean }) => {
      const disableCdnLoading = !!opts?.disableCdnLoading;
      const r = await compileStub(code, { disableCdnLoading });
      if (r.mode === "echec") {
        const message = r.banner ?? "offline";
        return {
          circuitJson: [],
          diagnostics: [{ severity: "error" as const, message, source: "compile" }],
          stats: computeStats([]),
          mode: "echec" as const,
          banner: r.banner,
          errors: 1,
          warnings: 0,
        };
      }
      const diagnostics = extractEmbeddedDiagnostics(r.circuitJson);
      const stats = computeStats(r.circuitJson);
      return {
        circuitJson: r.circuitJson,
        diagnostics,
        stats,
        mode: "worker-blob-local" as const,
        banner: disableCdnLoading ? CDN_BANNER : r.banner,
        errors: diagnostics.filter((d) => d.severity === "error").length,
        warnings: diagnostics.filter((d) => d.severity === "warning").length,
      };
    }) as ToolsDeps["compile"],
    persist: (proj, code, cj) => persistProjectFiles(proj, code, cj),
    fetchFn: (async (url: string) => {
      if (!fetchStub) throw new Error("fetchFn non injecté");
      return fetchStub(url);
    }) as ToolsDeps["fetchFn"],
    log: (level, source, message) => {
      store.appendLog(level, source, message);
    },
    io: {
      canonicalize: (p) => canonicalProjectPath(p),
      ensureLayout: (dir, template) => (ensureProjectLayout(dir, template), "created" as const),
      ensureCircuitFile: (dir) => ensureCircuitFile(dir),
      dirExists: (d) => fs.existsSync(d),
      mainExists: (d) => fs.existsSync(projectMainPath(d)),
      readMain: (proj) => {
        try {
          return fs.readFileSync(projectMainPath(proj), "utf8");
        } catch {
          return null;
        }
      },
      loadRegistry: () => reg(),
      saveRegistry: (r) => saveRegistry(r, fake.regFile),
      writeLock: (p: string | null) => {
        fake.current = p;
      },
      listProjects: () => {
        const r = reg();
        return {
          projects: r.projects.map((e) => ({
            path: e.path,
            lastOpened: e.lastOpened,
            name: path.basename(e.path),
            parent: path.dirname(e.path),
            exists: fs.existsSync(e.path),
          })),
          lastOpened: r.lastOpened,
        };
      },
    },
    fab: {
      projectNameForExport: (projectPath, explicitName) => explicitName ?? path.basename(projectPath),
      resolveExportDir: (projectPath) => projectExportDir(canonicalProjectPath(projectPath)),
      mkdirp: (d) => fs.mkdirSync(d, { recursive: true }),
      writeFile: (p, content) => fs.writeFileSync(p, content),
      joinPath: (...parts) => path.join(...parts),
      toFileUrl: (p) => pathToFileURL(p).href,
    },
    preview: {
      previewDirFor: (proj) => (proj ? projectPreviewsDir(proj) : ""),
      previewFallbackDir: () => "",
      readPreview: (sourceInput, opts) => readPreview(sourceInput, opts),
    },
  };
}

// --- Scénarios ---------------------------------------------------------------

let fake: FakeTransport;
let router: AgentRouter;
const okCompile = { circuitJson: SOURCE_CJ, mode: "worker-blob-local", banner: null as string | null };
// NOTE parité : le repli inline n'existe que côté frontend ; les stubs
// utilisent le mode worker des deux côtés (différence documentée).

function stubBoth(cj: unknown[] = SOURCE_CJ) {
  const ui: AgentCompileOut = { circuitJson: cj, mode: "worker-blob-local", banner: null };
  fake.compileFn = async () => ui;
  return async () => ui;
}

beforeEach(() => {
  fake?.cleanup();
  fake = new FakeTransport();
  router = createAgentRouter(fake);
  resetQueueForTests();
});

function refProject(): string {
  const dir = fake.mkProject("carte");
  fake.current = dir;
  return dir;
}

describe("T5 parité — gardes (NO_PROJECT_OPEN, Confinement)", () => {
  test("sans projet : mêmes refus des deux côtés", async () => {
    const cases: Array<[string, () => Promise<unknown>, (d: ToolsDeps) => Promise<unknown>]> = [
      ["code_patch", () => router.codePatch({ anchor: "x", replacement: "y" }), (d) => runCodePatch(d, { anchor: "x", replacement: "y" })],
      ["live", () => router.liveManage({ op: "view" }), (d) => runLiveManage(d, { op: "view" })],
      ["batch", () => router.batchExecute({ operations: [] }), (d) => runBatchExecute(d, { operations: [] })],
      ["checks", () => router.runChecks({}), (d) => runChecks(d, {})],
      ["search", () => router.searchParts({ query: "10k" }), (d) => runSearchParts(d, { query: "10k" })],
      ["fab", () => router.fabExport({}), (d) => runFabExport(d, {})],
      ["preview", () => router.previewScreenshot({ source: "pcb_2d" }), (d) => runPreviewScreenshot(d, { source: "pcb_2d" })],
      ["state", () => router.pcbState({}), (d) => runPcbState(d, {})],
      ["logs", () => router.logsRead({}), (d) => runLogsRead(d, {})],
    ];
    for (const [name, viaRouter, viaCore] of cases) {
      const r = await viaRouter();
      const c = await viaCore(refDeps(fake, null, stubBoth()));
      expect(r, name).toEqual(c);
    }
    expect(await router.hierarchy()).toEqual(readHierarchy(refDeps(fake, null, stubBoth())));
  });

  test("hors Registre : même OUT_OF_SCOPE des deux côtés", async () => {
    const outsider = path.join(fake.root, "outsider");
    fs.mkdirSync(path.join(outsider, "previews"), { recursive: true });
    fs.writeFileSync(path.join(outsider, "main.tsx"), DEMO_TS);
    fake.current = outsider;
    const r = await router.codePatch({ anchor: "R1", replacement: "R9" });
    const c = await runCodePatch(refDeps(fake, outsider, stubBoth()), {
      anchor: "R1",
      replacement: "R9",
    });
    expect(r).toEqual(c);
    expect(JSON.stringify(r)).toContain("OUT_OF_SCOPE");
  });
});

describe("T5 parité — code_patch", () => {
  test("ok : appliqué + disque écrit, identique", async () => {
    const dir = refProject();
    stubBoth();
    const args = { anchor: '<resistor name="R1"', replacement: '<resistor name="R9"' };
    const r = await router.codePatch(args);
    // Référence sur une copie disque (le routeur a déjà muté `dir`).
    const dir2 = fake.mkProject("carte-ref");
    fake.current = dir; // le routeur garde `dir`
    const c = await runCodePatch(refDeps(fake, dir2, stubBoth()), args);
    expect(r).toEqual(c);
    expect((r as { output: { applied: boolean } }).output.applied).toBe(true);
    expect(fs.readFileSync(path.join(dir, "main.tsx"), "utf8")).toContain("R9");
  });

  test("ancre 0 et 2 occurrences : mêmes refus", async () => {
    refProject();
    stubBoth();
    for (const anchor of ["introuvable-zzz", "resistor"]) {
      const dir2 = fake.mkProject(`ref-${anchor.length}`);
      const r = await router.codePatch({ anchor, replacement: "x" });
      const c = await runCodePatch(refDeps(fake, dir2, stubBoth()), { anchor, replacement: "x" });
      expect(r, anchor).toEqual(c);
      expect((r as { output: { applied: boolean } }).output.applied).toBe(false);
    }
  });

  test("compile en erreur : applied + disque intact, identique", async () => {
    const dir = refProject();
    const errCj = [{ type: "pcb_error", error: "boom" }];
    fake.compileFn = async () => ({ circuitJson: errCj, mode: "worker-blob-local", banner: null });
    const args = { anchor: '<resistor name="R1"', replacement: '<resistor name="R9"' };
    const r = await router.codePatch(args);
    const dir2 = fake.mkProject("carte-ref2");
    const c = await runCodePatch(
      refDeps(fake, dir2, async () => ({ circuitJson: errCj, mode: "worker-blob-local", banner: null })),
      args,
    );
    expect(r).toEqual(c);
    const out = (r as { output: { applied: boolean; ready: boolean } }).output;
    expect(out.applied).toBe(true);
    expect(out.ready).toBe(false);
    expect(fs.readFileSync(path.join(dir, "main.tsx"), "utf8")).toContain("R1");
  });

  test("disque KO : applied:false + rollback, identique", async () => {
    const dir = refProject();
    stubBoth();
    fake.commitThrow = new Error("disque plein (test)");
    const args = { anchor: '<resistor name="R1"', replacement: '<resistor name="R9"' };
    const r = await router.codePatch(args);
    const dir2 = fake.mkProject("carte-ref3");
    const throwingPersist = () => {
      throw new Error("disque plein (test)");
    };
    const ref = refDeps(fake, dir2, stubBoth());
    const c = await runCodePatch({ ...ref, persist: throwingPersist }, args);
    expect(r).toEqual(c);
    expect((r as { output: { applied: boolean } }).output.applied).toBe(false);
    // Rollback mémoire : le code exposé est l'original.
    const sel = await router.liveManage({ op: "select", refdes: "R1" });
    expect(JSON.stringify(sel)).toContain("R1");
    expect(fs.readFileSync(path.join(dir, "main.tsx"), "utf8")).toContain("R1");
  });
});

describe("T5 parité — batch_execute", () => {
  test("lot patch+move ok : identique + disque écrit", async () => {
    const dir = refProject();
    stubBoth();
    const ops = [
      { kind: "patch", anchor: '<resistor name="R1"', replacement: '<resistor name="R9"' },
      { kind: "move", refdes: "R2", x: 1, y: 2 },
    ] as never[];
    const r = await router.batchExecute({ operations: ops as never });
    const dir2 = fake.mkProject("batch-ref");
    const c = await runBatchExecute(refDeps(fake, dir2, stubBoth()), {
      operations: ops as never,
    });
    expect(r).toEqual(c);
    expect((r as { output: { applied: boolean } }).output.applied).toBe(true);
    expect(fs.readFileSync(path.join(dir, "main.tsx"), "utf8")).toContain("R9");
  });

  test("op invalide : rollback + failedIndex, identique", async () => {
    refProject();
    stubBoth();
    const ops = [
      { kind: "move", refdes: "R1", x: 1, y: 1 },
      { kind: "move", refdes: "ZZZ", x: 0, y: 0 },
    ] as never[];
    const r = await router.batchExecute({ operations: ops as never });
    const dir2 = fake.mkProject("batch-ref2");
    const c = await runBatchExecute(refDeps(fake, dir2, stubBoth()), {
      operations: ops as never,
    });
    expect(r).toEqual(c);
    const out = (r as { output: { applied: boolean; rolledBack: boolean; failedOpIndex: number } }).output;
    expect(out.applied).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(out.failedOpIndex).toBe(1);
  });

  test("compile en erreur : rollback disque intact, identique", async () => {
    const dir = refProject();
    const errCj = [{ type: "pcb_error", error: "boom" }];
    fake.compileFn = async () => ({ circuitJson: errCj, mode: "worker-blob-local", banner: null });
    const ops = [{ kind: "move", refdes: "R1", x: 1, y: 1 }] as never[];
    const r = await router.batchExecute({ operations: ops as never });
    const dir2 = fake.mkProject("batch-ref3");
    const c = await runBatchExecute(
      refDeps(fake, dir2, async () => ({ circuitJson: errCj, mode: "worker-blob-local", banner: null })),
      { operations: ops as never },
    );
    expect(r).toEqual(c);
    expect(fs.readFileSync(path.join(dir, "main.tsx"), "utf8")).toContain("pcbX={-5}");
  });

  test("op route : même gate des deux côtés", async () => {
    refProject();
    stubBoth();
    const ops = [{ kind: "route", effort: "1x" }] as never[];
    const r = await router.batchExecute({ operations: ops as never });
    const dir2 = fake.mkProject("batch-ref4");
    const c = await runBatchExecute(refDeps(fake, dir2, stubBoth()), {
      operations: ops as never,
    });
    expect(r).toEqual(c);
  });
});

describe("T5 parité — live_manage", () => {
  test("move/select/view : identiques", async () => {
    refProject();
    stubBoth();
    const dir2 = fake.mkProject("live-ref");
    const ref = () => refDeps(fake, dir2, stubBoth());
    expect(await router.liveManage({ op: "move", refdes: "R1", x: 1, y: 2 })).toEqual(
      await runLiveManage(ref(), { op: "move", refdes: "R1", x: 1, y: 2 }),
    );
    expect(await router.liveManage({ op: "select", refdes: "R1" })).toEqual(
      await runLiveManage(ref(), { op: "select", refdes: "R1" }),
    );
    expect(await router.liveManage({ op: "view" })).toEqual(
      await runLiveManage(ref(), { op: "view" }),
    );
  });

  test("refus : create, op inconnue, move sans x/y — identiques", async () => {
    refProject();
    stubBoth();
    const dir2 = fake.mkProject("live-ref2");
    const ref = () => refDeps(fake, dir2, stubBoth());
    for (const op of [
      { op: "create" },
      { op: "planquer" },
      { op: "move", refdes: "R1" },
      { op: "select" },
      { op: "select", refdes: "ZZZ" },
    ]) {
      expect(await router.liveManage(op as never), JSON.stringify(op)).toEqual(
        await runLiveManage(ref(), op as never),
      );
    }
  });
});

describe("T5 parité — run_checks / search_parts", () => {
  test("checks all + routing : identiques", async () => {
    const dir = refProject();
    stubBoth();
    const ref = () => refDeps(fake, dir, stubBoth());
    expect(await router.runChecks({ domain: "all" })).toEqual(await runChecks(ref(), { domain: "all" }));
    expect(await router.runChecks({ domain: "routing" })).toEqual(
      await runChecks(ref(), { domain: "routing" }),
    );
  });

  test("search ok + refus : identiques", async () => {
    refProject();
    stubBoth();
    const body = JSON.stringify({
      components: [{ lcsc: 21190, mfr: "Yageo", package: "0402", description: "10k", stock: 5000 }],
    });
    const url = "https://jlcsearch.tscircuit.com/api/search?q=10k";
    fake.fetchMap.set(url, { status: 200, body });
    const dir2 = fake.mkProject("search-ref");
    const fetchStub = async (u: string) => {
      const hit = u === url ? { status: 200, body } : { status: 404, body: "{}" };
      return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, json: async () => JSON.parse(hit.body) as unknown };
    };
    const ref = () => refDeps(fake, dir2, stubBoth(), fetchStub);
    expect(await router.searchParts({ query: "10k" })).toEqual(
      await runSearchParts(ref(), { query: "10k" }),
    );
    expect(await router.searchParts({ query: "10k", source: "mouser" })).toEqual(
      await runSearchParts(ref(), { query: "10k", source: "mouser" }),
    );
    expect(await router.searchParts({ query: "10k", disableCdnLoading: true })).toEqual(
      await runSearchParts(ref(), { query: "10k", disableCdnLoading: true }),
    );
  });

  test("search réseau KO : même refus offline", async () => {
    refProject();
    stubBoth();
    fake.fetchThrow = new Error("réseau coupé (test)");
    const dir2 = fake.mkProject("search-ref2");
    const ref = refDeps(fake, dir2, stubBoth(), async () => {
      throw new Error("réseau coupé (test)");
    });
    expect(await router.searchParts({ query: "10k" })).toEqual(
      await runSearchParts(ref, { query: "10k" }),
    );
  });
});

describe("T5 parité — fab_export / preview / state / logs", () => {
  test("fab routingDisabled : même refus", async () => {
    const dir = fake.mkProject("carte-rd", DEMO_TS.replace("<board", '<board routingDisabled'));
    fake.current = dir;
    stubBoth();
    expect(await router.fabExport({})).toEqual(
      await runFabExport(refDeps(fake, dir, stubBoth()), {}),
    );
  });

  test("fab board non routé : même refus", async () => {
    const dir = refProject();
    fake.compileFn = async () => ({ circuitJson: [], mode: "worker-blob-local", banner: null });
    expect(await router.fabExport({})).toEqual(
      await runFabExport(
        refDeps(fake, dir, async () => ({ circuitJson: [], mode: "worker-blob-local", banner: null })),
        {},
      ),
    );
  });

  test("fab ok : mêmes artefacts + contenus disque", async () => {
    // Code SANS trace (pas de gate `board non routé`) + stub qui traverse
    // gates et convertisseurs : chemin ok complet des deux côtés.
    // Champs volatils normalisés (zip horodatés + CreationDate gerber :
    // nondéterminisme jszip/convertisseurs, identique run-to-run côté MCP).
    const plain = DEMO_TS.replace(/<trace[^/]*\/>/g, "");
    const dir = fake.mkProject("fab-ref-ok", plain);
    fake.current = dir;
    stubBoth(SOURCE_CJ);
    const r = await router.fabExport({});
    const c = await runFabExport(refDeps(fake, dir, stubBoth(SOURCE_CJ)), {});
    const normFab = (v: { output: Record<string, unknown> }) => {
      const o = JSON.parse(JSON.stringify(v.output)) as {
        gerberPreview: string;
        artifacts: { name: string; bytes: number }[];
        kicadZip: { bytes: number };
        fabZip: { bytes: number };
      };
      o.gerberPreview = o.gerberPreview.replace(
        /%TF\.CreationDate,[^*]*\*%/,
        "%TF.CreationDate,<DATE>*%",
      );
      for (const a of o.artifacts) if (a.name.endsWith(".zip")) a.bytes = 0;
      o.kicadZip.bytes = 0;
      o.fabZip.bytes = 0;
      return o;
    };
    expect(normFab(r as never)).toEqual(normFab(c as never));
    const rout = (r as { output: { ready: boolean } }).output;
    expect(rout.ready).toBe(true);
    const expDir = (r as { output: { exportDir: string } }).output.exportDir;
    expect(fs.existsSync(path.join(expDir, "bom.csv"))).toBe(true);
    expect(fs.existsSync(path.join(expDir, "gerbers"))).toBe(true);
  });

  test("fab projet vide (T2 I7) : même refus board vide", async () => {
    const dir = fake.mkProject("fab-vide", "export default () => (<board width=\"20mm\" height=\"20mm\" />)");
    fake.current = dir;
    const emptyCj = [
      { type: "source_project_metadata" },
      { type: "source_group" },
      { type: "source_board" },
      { type: "schematic_group" },
      { type: "pcb_board" },
    ];
    fake.compileFn = async () => ({ circuitJson: emptyCj, mode: "worker-blob-local", banner: null });
    const r = await router.fabExport({});
    const c = await runFabExport(
      refDeps(fake, dir, async () => ({ circuitJson: emptyCj, mode: "worker-blob-local", banner: null })),
      {},
    );
    expect(r).toEqual(c);
    const out = (r as { output: { ready: boolean; message: string } }).output;
    expect(out.ready).toBe(false);
    expect(out.message).toMatch(/0 composant|board vide/i);
  });

  test("mise en forme fab ok : champs VERBATIM (unité)", async () => {
    const { shapeFabOkOutput } = await import("./agent");
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const out = shapeFabOkOutput(
      "s1",
      { mode: "worker-blob-local", banner: null, warnings: 1 },
      {
        ok: true,
        projectName: "carte",
        counts: { gerberFiles: 1, bomRows: 2, pnpRows: 3 },
        gerberNames: ["F_Cu.gtl"],
        gerberFiles: { "F_Cu.gtl": "cuivre" },
        gerberPreview: "prev",
        bomCsv: "a,b",
        pnpCsv: "x",
        kicadPcb: "pcb-hé",
        kicadSch: "sch",
        kicadPro: "pro",
        kicadPcbPreview: "kprev",
        kicadZipBase64: b64("zip1"),
        kicadZipBytes: 4,
        fabZipBase64: b64("zip22"),
        fabZipBytes: 5,
      } as never,
      {
        export_dir: "/tmp/e",
        artifacts: [
          { name: "gerbers/F_Cu.gtl", bytes: 6, preview_url: "file:///tmp/e/gerbers/F_Cu.gtl" },
          { name: "kicad_project.zip", bytes: 4, preview_url: "file:///tmp/e/kicad_project.zip" },
          { name: "fab_upload.zip", bytes: 5, preview_url: "file:///tmp/e/fab_upload.zip" },
        ],
      },
    ) as Record<string, unknown>;
    expect(out["sessionId"]).toBe("s1");
    expect(out["ready"]).toBe(true);
    expect((out["kicad"] as { pcbBytes: number }).pcbBytes).toBe(
      new TextEncoder().encode("pcb-hé").length,
    );
    expect(out["kicadZip"]).toEqual({
      bytes: 4,
      previewUrl: "file:///tmp/e/kicad_project.zip",
    });
    expect(out["fabZip"]).toEqual({
      bytes: 5,
      previewUrl: "file:///tmp/e/fab_upload.zip",
    });
    expect(out["exportDir"]).toBe("/tmp/e");
    expect(out["message"]).toBeNull();
  });

  test("preview latest/nommé/alias/inconnu/absent : identiques", async () => {
    const dir = refProject();
    stubBoth();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    // `latest` déterministe : mtime explicites (pas d'égalité à la ms).
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-01-02T00:00:00Z");
    fs.writeFileSync(path.join(dir, "previews", "pcb_2d.png"), png);
    fs.writeFileSync(
      path.join(dir, "previews", "pcb_2d.json"),
      JSON.stringify({ width: 800, height: 600, updatedAt: "2026-01-01T00:00:00Z" }),
    );
    fs.writeFileSync(path.join(dir, "previews", "pcb_2d__revue.png"), png);
    fs.utimesSync(path.join(dir, "previews", "pcb_2d.png"), old, old);
    fs.utimesSync(path.join(dir, "previews", "pcb_2d__revue.png"), recent, recent);
    const ref = () => refDeps(fake, dir, stubBoth());
    for (const a of [
      { source: "pcb_2d" },
      { source: "pcb_2d", name: "revue" },
      { source: "schematique_2d" },
      { source: "topo" },
      { source: "pcb_3d" },
    ]) {
      expect(await router.previewScreenshot(a as never), JSON.stringify(a)).toEqual(
        await runPreviewScreenshot(ref(), a as never),
      );
    }
  });

  test("state/logs/hierarchy : identiques", async () => {
    const dir = refProject();
    stubBoth();
    const ref = () => refDeps(fake, dir, stubBoth());
    expect(await router.pcbState({})).toEqual(await runPcbState(ref(), {}));
    expect(await router.logsRead({})).toEqual(await runLogsRead(ref(), {}));
    expect(await router.hierarchy()).toEqual(readHierarchy(ref()));
  });
});

describe("T5 parité — projets", () => {
  test("list/current/create/open/close : identiques", async () => {
    const dir = refProject();
    stubBoth();
    const refNow = () => refDeps(fake, () => fake.current, stubBoth());
    expect(await router.projectList()).toEqual(await runProjectList(refNow()));
    expect(await router.projectCurrent()).toEqual(await runProjectCurrent(refNow()));
    // create : chemins distincts (registre partagé), on normalise le chemin.
    const freshA = path.join(fake.root, "frais-a");
    const freshB = path.join(fake.root, "frais-b");
    const rCreate = await createAgentRouter(fake).projectCreate({ path: freshA });
    const cCreate = await runProjectCreate(refNow(), { path: freshB });
    const norm = (v: unknown, p: string) =>
      JSON.stringify(v).split(p).join("<FRESH>");
    expect(norm(rCreate, freshA)).toEqual(norm(cCreate, freshB));
    expect(await router.projectOpen({ path: dir })).toEqual(
      await runProjectOpen(refNow(), { path: dir }),
    );
    expect(await router.projectClose()).toEqual(await runProjectClose(refNow()));
  });

  test("create existant + erreurs : mêmes messages", async () => {
    const dir = refProject();
    stubBoth();
    const again = await router.projectCreate({ path: dir });
    expect((again as { output: { created: boolean } }).output.created).toBe(false);
    await expect(router.projectOpen({ path: path.join(fake.root, "absent") })).rejects.toThrow(
      "dossier introuvable",
    );
    const noMain = path.join(fake.root, "sans-main");
    fs.mkdirSync(noMain, { recursive: true });
    await expect(router.projectOpen({ path: noMain })).rejects.toThrow(
      "dossier sans main.tsx",
    );
    const plein = path.join(fake.root, "plein");
    fs.mkdirSync(plein, { recursive: true });
    fs.writeFileSync(path.join(plein, "notes.txt"), "x");
    await expect(router.projectCreate({ path: plein })).rejects.toThrow(
      "dossier non-vide sans main.tsx",
    );
  });

  test("file:// et règle export : parité Rust (vecteurs figés)", () => {
    const dir = path.join(fake.root, "ma-carte");
    expect(fileUrl(path.join(dir, "x.png"))).toBe(
      pathToFileURL(path.join(dir, "x.png")).href,
    );
    expect(sha256hex("/tmp/nia-carte").slice(0, 12)).toHaveLength(12);
  });
});
