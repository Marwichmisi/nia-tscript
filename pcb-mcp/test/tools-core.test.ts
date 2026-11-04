// T1 — cœur tools-core : coutures pures + garde anti-effets.
// Seams sous test (ticket #56, étude §4 item 1) :
// - tools-core/{patch,live,batch,board,queue} : même comportement que src/*
//   (parité sur la fixture BOARD_CODE, littéraux indépendants) ;
// - garde statique : aucun import node:/process.env/@tscircuit/eval dans le cœur.
// Comportement externe MCP inchangé : couvert par les suites HTTP existantes.
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BOARD_CODE, emptyStats } from "../src/tools-core/board";
import { createMemoryStore, type MemoryStore } from "../src/tools-core/store";
import { applyAnchoredPatch } from "../src/tools-core/patch";
import { applyMove } from "../src/tools-core/live";
import { applyBatch } from "../src/tools-core/batch";
import { enqueue, resetQueueForTests } from "../src/tools-core/queue";
import { extractEmbeddedDiagnostics } from "../src/tools-core/diagnostics";
import { parseQueryHints, resolveFootprint, scorePart } from "../src/tools-core/sourcing";
import { sanitizeSegment } from "../src/tools-core/fab";
import {
  BatchExecuteInput,
  BatchOpSchema,
  CodePatchInput,
  FabExportInput,
  LiveManageInput,
  SearchPartsInput,
} from "../src/tools-core/schemas";
import { buildToolsManifest, TOOL_DEFS } from "../src/tools-core/manifest";
import type { ToolsDeps } from "../src/tools-core/deps";
import type { CompileResult } from "../src/tools-core/diagnostics";
import {
  liveOpNeedsQueue,
  requireConfinedProject,
  runBatchExecute,
  runCodePatch,
  runLiveManage,
  runPcbState,
} from "../src/tools-core/tools";
import {
  assertProjectMember,
  canonicalProjectPath,
  emptyRegistry,
  isProjectMember,
  NO_PROJECT_OPEN,
  OUT_OF_SCOPE,
  parseCircuitFile,
  reconcileRegistry,
  serializeCircuitFile,
  templateCode,
  upsertRegistry,
  validateProjectPath,
} from "../src/tools-core/project-core";

const CORE_DIR = path.join(import.meta.dir, "..", "src", "tools-core");

describe("T1 — tools-core pur : parité src/*", () => {
  test("patch ancré via le cœur : 1 occurrence → code remplacé", () => {
    const out = applyAnchoredPatch(
      BOARD_CODE,
      `<resistor name="R1" resistance="10k"`,
      `<resistor name="R1" resistance="4.7k"`,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`resistance="4.7k"`);
  });

  test("live move via le cœur : R1 déplacée", () => {
    const out = applyMove(BOARD_CODE, "R1", 3, -2);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`pcbX={3}`);
    expect(out.code).toContain(`pcbY={-2}`);
  });

  test("batch via le cœur : lot mixte patch + move", () => {
    const out = applyBatch(BOARD_CODE, [
      {
        kind: "patch",
        anchor: `resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`,
        replacement: `resistance="4.7k" footprint="0402" pcbX={-5} pcbY={4}`,
      },
      { kind: "move", refdes: "R1", x: 3, y: -2 },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`resistance="4.7k"`);
    expect(out.code).toContain(`pcbX={3}`);
  });

  test("file sérialisée du cœur : ordre d'arrivée préservé", async () => {
    resetQueueForTests();
    const order: number[] = [];
    await Promise.all([
      enqueue(async () => {
        order.push(1);
      }),
      enqueue(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});

describe("T1 — tools-core/diagnostics : extracteur strict du sidecar", () => {
  test("type _error → erreur sourcée circuit-json", () => {
    const out = extractEmbeddedDiagnostics([
      { type: "pcb_placement_error", message: "overlap" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "error", source: "circuit-json" });
  });

  test("error_report (sous-chaîne nue) → ignoré, pas de faux positif", () => {
    const out = extractEmbeddedDiagnostics([{ type: "error_report", message: "x" }]);
    expect(out).toEqual([]);
  });

  test("champ explicite error_message → erreur même sans type", () => {
    const out = extractEmbeddedDiagnostics([{ type: "autre", error_message: "boom" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "error", message: "boom" });
  });
});

describe("T1 — tools-core/sourcing+fabrication : pur sans I/O", () => {
  test("parseQueryHints : 10k 0402 → package + valeur + kind", () => {
    expect(parseQueryHints("10k 0402")).toMatchObject({
      packageHint: "0402",
      valueToken: "10k",
      kindHint: "resistor",
    });
  });

  test("resolveFootprint : package 0603 valide → fallback-package compilé", () => {
    const out = resolveFootprint("0603", null);
    expect(out.footprint).toBe("0603");
    expect(out.footprintSource).toBe("fallback-package");
  });

  test("scorePart : package exact + famille + stock > bruit", () => {
    const hints = parseQueryHints("10k 0402");
    const good = scorePart({ package: "0402", description: "10k resistor", stock: 5 }, hints);
    const bad = scorePart({ package: "1206", description: "capacitor", stock: 0 }, hints);
    expect(good).toBeGreaterThan(bad);
  });

  test("sanitizeSegment : vide → default, séparateurs → tirets", () => {
    expect(sanitizeSegment("")).toBe("default");
    expect(sanitizeSegment("ma carte/v1")).toBe("ma-carte-v1");
  });
});

describe("T1 — tools-core/project-core : pur sans I/O", () => {
  test("templateCode : vide/demo, inconnu → null", () => {
    expect(templateCode("vide")).toContain("<board");
    // Garde verbatim : le gabarit démo est la fixture BOARD_CODE.
    expect(templateCode("demo")).toBe(BOARD_CODE);
    expect(templateCode("nope")).toBeNull();
  });

  test("circuit.json : enveloppe versionnée, legacy migré en mémoire, corrompu → throw", () => {
    const text = serializeCircuitFile([{ type: "x" }]);
    expect(parseCircuitFile(text)).toMatchObject({ version: 1 });
    expect(parseCircuitFile(`[{ "type": "x" }]`)).toMatchObject({ version: 1 });
    expect(() => parseCircuitFile("pas du json")).toThrow(/circuit\.json/);
  });

  test("validate : absolu exigé, traversal refusé, slash final normalisé", () => {
    expect(validateProjectPath("/a/b/")).toBe("/a/b");
    expect(() => validateProjectPath("relatif/x")).toThrow(/absolu/);
    expect(() => validateProjectPath("/tmp/../etc")).toThrow(/traversal/);
    expect(() => validateProjectPath("")).toThrow(/vide/);
  });

  test("Confinement pur : membre après canonicalisation, slash final et symlink", () => {
    const reg = upsertRegistry(emptyRegistry(), "/projets/demo");
    expect(isProjectMember("/projets/demo", reg)).toBe(true);
    expect(isProjectMember("/projets/demo/", reg)).toBe(true);
    expect(isProjectMember("/ailleurs", reg)).toBe(false);
    expect(assertProjectMember("/projets/demo/", reg)).toBe("/projets/demo");
    expect(() => assertProjectMember("/ailleurs", reg)).toThrow(/hors périmètre/);
    expect(NO_PROJECT_OPEN).toBe("NO_PROJECT_OPEN");
    expect(OUT_OF_SCOPE).toBe("OUT_OF_SCOPE");
  });

  test("canonical pure : symlink résolu via realpath injecté", () => {
    const fake = (p: string) => (p === "/lien" ? "/projets/demo" : p);
    expect(canonicalProjectPath("/lien", { realpath: fake })).toBe("/projets/demo");
  });

  test("reconcile : orphelin conservé, lastOpened réparé (exists injecté)", () => {
    const reg = upsertRegistry(upsertRegistry(emptyRegistry(), "/vivant"), "/mort");
    const out = reconcileRegistry(reg, (p) => p === "/vivant");
    expect(out.orphans).toEqual(["/mort"]);
    expect(out.registry.lastOpened).toBe("/vivant");
    expect(out.currentReset).toBe(true);
  });
});

describe("T1 — tools-core/store : mémoire pure, Projet injecté", () => {
  test("snapshot/restore : rollback fichier+live", () => {
    const store = createMemoryStore(BOARD_CODE);
    const snap = store.snapshot();
    store.setCode(BOARD_CODE + "\n// mutation");
    store.setLastCompile({ status: "error", errors: 1, warnings: 0 });
    store.restore(snap);
    expect(store.getCode()).toBe(BOARD_CODE);
    expect(store.getBoardState("demo").compile).toMatchObject({ status: "ok", errors: 0 });
  });

  test("boardName injecté : pas de résolution Projet dans le cœur", () => {
    const store = createMemoryStore(BOARD_CODE);
    expect(store.getBoardState("mon-projet").board).toBe("mon-projet");
    expect(store.getBoardState("mon-projet").protocolVersion).toBe("2026-07-28");
  });

  test("logs : curseur + compteur d'erreurs", () => {
    const store = createMemoryStore(BOARD_CODE);
    store.appendLog("error", "compile", "boom");
    const page = store.readLogs({ limit: 100 });
    expect(page.newErrors).toBeGreaterThanOrEqual(1);
    expect(page.entries.at(-1)?.message).toBe("boom");
  });
});

describe("T1 — tools-core/schemas+manifeste : contrat d'outils unique", () => {
  test("BatchOpSchema : op patch valide, op inconnue rejetée", () => {
    expect(BatchOpSchema.safeParse({ kind: "patch", anchor: "a", replacement: "b" }).success).toBe(true);
    expect(BatchOpSchema.safeParse({ kind: "teleport", x: 1 }).success).toBe(false);
  });

  test("inputs : code_patch exige anchor+replacement, search_parts une query", () => {
    expect(CodePatchInput.safeParse({ anchor: "a", replacement: "b" }).success).toBe(true);
    expect(CodePatchInput.safeParse({ anchor: "", replacement: "b" }).success).toBe(false);
    expect(SearchPartsInput.safeParse({ query: "10k" }).success).toBe(true);
    expect(LiveManageInput.safeParse({ op: "move" }).success).toBe(true);
    expect(FabExportInput.safeParse({}).success).toBe(true);
    expect(BatchExecuteInput.safeParse({ operations: [] }).success).toBe(true);
  });

  test("manifeste : 14 outils, nom/description/annotations pour le prompt système", () => {
    const names = Object.keys(TOOL_DEFS).sort();
    expect(names).toEqual(
      [
        "batch_execute",
        "code_patch",
        "fab_export",
        "live_manage",
        "logs_read",
        "pcb_state",
        "preview_screenshot",
        "project_close",
        "project_create",
        "project_current",
        "project_list",
        "project_open",
        "run_checks",
        "search_parts",
      ].sort(),
    );
    const manifest = buildToolsManifest();
    expect(manifest).toHaveLength(14);
    for (const entry of manifest) {
      expect(typeof entry.name).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
    expect(TOOL_DEFS.code_patch.annotations).toMatchObject({ destructiveHint: true });
    expect(TOOL_DEFS.pcb_state.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("T1 — tools-core/tools : orchestration à effets injectés", () => {
  function compileOk(code: string): Promise<CompileResult> {
    return Promise.resolve({
      circuitJson: [],
      diagnostics: [],
      stats: emptyStats(),
      mode: "worker-blob-local",
      banner: null,
      errors: 0,
      warnings: 0,
    });
  }

  function makeDeps(overrides?: Partial<ToolsDeps> & { store?: MemoryStore }): ToolsDeps {
    const { store = createMemoryStore(BOARD_CODE), ...rest } = overrides ?? {};
    return {
      resolveProject: () => "/projets/demo",
      assertMember: (p) => {
        if (p !== "/projets/demo") {
          throw new Error(
            `hors périmètre (Confinement) : ${p} — opération refusée, le dossier n'est pas un Projet du Registre`,
          );
        }
        return p;
      },
      boardName: () => "demo",
      compile: compileOk,
      persist: () => {},
      fetchFn: (async () => {
        throw new Error("pas de réseau dans les tests cœur");
      }) as unknown as ToolsDeps["fetchFn"],
      log: () => {},
      io: {
        canonicalize: (p) => p,
        ensureLayout: () => "exists",
        ensureCircuitFile: () => "exists",
        dirExists: () => true,
        mainExists: () => true,
        readMain: () => BOARD_CODE,
        loadRegistry: () => emptyRegistry(),
        saveRegistry: () => {},
        writeLock: () => {},
        listProjects: () => ({ projects: [], lastOpened: null }),
      },
      fab: {
        projectNameForExport: () => "demo",
        resolveExportDir: () => "/tmp/exports-test",
        mkdirp: () => {},
        writeFile: () => {},
        joinPath: (...parts: string[]) => parts.join("/"),
        toFileUrl: (p: string) => `file://${p}`,
      },
      preview: {
        previewDirFor: () => "",
        previewFallbackDir: () => "",
        readPreview: () => ({
          found: false,
          source: "pcb_2d",
          name: null,
          dataUrl: null,
          bytes: 0,
          width: null,
          height: null,
          previewUrl: null,
          updatedAt: null,
          banner: null,
          message: "rien",
          errors: 1,
          warnings: 0,
        }),
      },
      ...rest,
      store,
    };
  }

  test("garde Confinement : membre / hors périmètre / sans Projet", () => {
    const deps = makeDeps();
    expect(requireConfinedProject("code_patch", deps)).toMatchObject({
      proj: "/projets/demo",
      scopeErr: null,
    });
    const outsider = makeDeps({
      assertMember: (p) => {
        throw new Error(
          `hors périmètre (Confinement) : ${p} — opération refusée, le dossier n'est pas un Projet du Registre`,
        );
      },
    });
    const refused = requireConfinedProject("code_patch", outsider);
    expect(refused.proj).toBe("/projets/demo");
    expect(refused.scopeErr?.code).toBe("OUT_OF_SCOPE");
    const accueil = makeDeps({ resolveProject: () => null });
    expect(requireConfinedProject("code_patch", accueil)).toMatchObject({
      proj: null,
      scopeErr: null,
    });
  });

  test("runPcbState : Accueil → NO_PROJECT_OPEN, Projet → board injecté", async () => {
    const accueil = makeDeps({ resolveProject: () => null });
    const closed = await runPcbState(accueil, {});
    expect(closed.output.ready).toBe(false);
    expect(closed.text).toContain("NO_PROJECT_OPEN");
    const deps = makeDeps();
    const open = await runPcbState(deps, {});
    expect(open.output.board).toBe("demo");
    expect(open.output.ready).toBe(true);
  });

  test("liveOpNeedsQueue : mutations sérialisées, lectures hors file", () => {
    expect(liveOpNeedsQueue("move")).toBe(true);
    expect(liveOpNeedsQueue("rotate")).toBe(true);
    expect(liveOpNeedsQueue("swap_package")).toBe(true);
    expect(liveOpNeedsQueue("reassign_net")).toBe(true);
    expect(liveOpNeedsQueue("select")).toBe(false);
    expect(liveOpNeedsQueue("view")).toBe(false);
    expect(liveOpNeedsQueue("create")).toBe(false);
    expect(liveOpNeedsQueue("frobnicate")).toBe(false);
  });

  test("runLiveManage select : lecture sans compile injectée", async () => {
    let compiled = false;
    const deps = makeDeps({
      compile: async (code) => {
        compiled = true;
        return compileOk(code);
      },
    });
    const out = await runLiveManage(deps, { op: "select", refdes: "R1" });
    expect(out.output.applied).toBe(true);
    expect(out.output.selection).toMatchObject({ refdes: "R1" });
    expect(compiled).toBe(false);
  });

  test("runCodePatch : patch → compile injectée → persistance injectée", async () => {
    const persisted: Array<{ projectPath: string; code: string }> = [];
    const deps = makeDeps({
      persist: (projectPath, code) => {
        persisted.push({ projectPath, code });
      },
    });
    const out = await runCodePatch(deps, {
      anchor: `<resistor name="R1" resistance="10k"`,
      replacement: `<resistor name="R1" resistance="4.7k"`,
    });
    expect(out.output.applied).toBe(true);
    expect(out.output.ready).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.projectPath).toBe("/projets/demo");
    expect(persisted[0]?.code).toContain(`resistance="4.7k"`);
    expect(deps.store.getCode()).toContain(`resistance="4.7k"`);
  });

  test("runCodePatch hors périmètre : refus sans toucher disque ni mémoire", async () => {
    let persisted = 0;
    const deps = makeDeps({
      assertMember: (p) => {
        throw new Error(
          `hors périmètre (Confinement) : ${p} — opération refusée, le dossier n'est pas un Projet du Registre`,
        );
      },
      persist: () => { persisted += 1; },
    });
    const before = deps.store.getCode();
    const out = await runCodePatch(deps, { anchor: "x", replacement: "y" });
    expect(out.output.applied).toBe(false);
    expect(out.output.mode).toBe("refuse");
    expect(persisted).toBe(0);
    expect(deps.store.getCode()).toBe(before);
  });

  test("runBatchExecute : lot patch+move atomique via compile injectée", async () => {
    const deps = makeDeps();
    const out = await runBatchExecute(deps, {
      operations: [
        {
          kind: "patch",
          anchor: `<resistor name="R1" resistance="10k"`,
          replacement: `<resistor name="R1" resistance="4.7k"`,
        },
        { kind: "move", refdes: "R1", x: 3, y: -2 },
      ],
    });
    expect(out.output.applied).toBe(true);
    expect(out.output.rolledBack).toBe(false);
    expect(out.output.code).toContain(`resistance="4.7k"`);
    expect(out.output.code).toContain(`pcbX={3}`);
  });

  test("runBatchExecute : op invalide → rollback, mémoire intacte", async () => {
    const deps = makeDeps();
    const before = deps.store.getCode();
    const out = await runBatchExecute(deps, {
      operations: [{ kind: "move", refdes: "R9", x: 1, y: 1 }],
    });
    expect(out.output.applied).toBe(false);
    expect(out.output.rolledBack).toBe(true);
    expect(out.output.failedOpIndex).toBe(0);
    expect(deps.store.getCode()).toBe(before);
  });
});

describe("T1 — tools-core : aucun effet (garde statique)", () => {  test("aucun import node:/process.env/@tscircuit/eval dans tools-core", () => {
    const files = fs
      .readdirSync(CORE_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(CORE_DIR, f), "utf8");
      const banned: Array<[RegExp, string]> = [
        [/from\s+["']node:/, "import node:"],
        [/require\(\s*["']node:/, "require node:"],
        [/process\.env/, "process.env"],
        [/@tscircuit\/eval/, "@tscircuit/eval"],
      ];
      for (const [re, label] of banned) {
        if (re.test(text)) violations.push(`${f}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
