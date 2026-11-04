// T2 (I12, #59) — route sur placement rouge : motif du gate prioritaire.
//
// Seam S4 (`runBatchExecute` avec op `route`) : quand le gate placement
// bloque, la sortie porte `routing refusé : <blockReason>`, jamais noyée
// sous les diagnostics compile.
import { describe, test, expect } from "bun:test";
import { BOARD_CODE, emptyStats } from "../src/tools-core/board";
import { createMemoryStore } from "../src/tools-core/store";
import { emptyRegistry } from "../src/tools-core/project-core";
import type { ToolsDeps } from "../src/tools-core/deps";
import type { CompileResult } from "../src/tools-core/diagnostics";
import { runBatchExecute } from "../src/tools-core/tools";

const BLOCK_REASON =
  "placement non vert : 1 violation(s) placement (overlap : R1 chevauche R2) — corrigez le placement avant tout routing";

function makeDeps(): ToolsDeps {
  const store = createMemoryStore(BOARD_CODE);
  return {
    resolveProject: () => "/projets/demo",
    assertMember: (p) => {
      if (p !== "/projets/demo") throw new Error(`hors périmètre (Confinement) : ${p}`);
      return p;
    },
    boardName: () => "demo",
    // Compile verte côté moteur mais diagnostics embarqués en erreur
    // (cas audit I12 : errors=12, routed=false) — le gate doit primer.
    compile: async (): Promise<CompileResult> => ({
      circuitJson: [{ type: "pcb_component" }],
      diagnostics: [
        { severity: "error", message: "diag compile générique 1", source: "circuit-json" },
        { severity: "error", message: "diag compile générique 2", source: "circuit-json" },
      ],
      stats: emptyStats(),
      mode: "worker-blob-local",
      banner: null,
      errors: 2,
      warnings: 0,
    }),
    persist: () => {},
    fetchFn: (async () => {
      throw new Error("pas de réseau dans ce test");
    }) as unknown as ToolsDeps["fetchFn"],
    log: () => {},
    checks: {
      runPlacementGate: async () => ({
        placementGreen: false,
        routingAllowed: false,
        missingCoords: [],
        placementViolations: [
          {
            domain: "placement" as const,
            type: "overlap",
            message: "R1 chevauche R2",
            x: 0,
            y: 0,
            refdes: "R1",
          },
        ],
        blockReason: BLOCK_REASON,
      }),
      runDomainChecks: async () => [],
    },
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
      resolveExportDir: () => "/tmp/x",
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
    store,
  };
}

describe("T2 I12 — route sur placement rouge : blockReason prioritaire", () => {
  test("S4 batch [route] compile en erreur + gate rouge → routing refusé : <blockReason>", async () => {
    const deps = makeDeps();
    const before = deps.store.getCode();
    const out = await runBatchExecute(deps, { operations: [{ kind: "route" }] });
    expect(out.output.applied).toBe(false);
    expect(out.output.rolledBack).toBe(true);
    expect(out.output.diagnostics.length).toBeGreaterThan(0);
    expect(out.output.diagnostics[0]!.message).toMatch(/routing refusé/);
    expect(out.output.diagnostics[0]!.message).toContain(BLOCK_REASON);
    expect(out.output.diagnostics[0]!.message).not.toMatch(/diag compile générique/);
    // Rollback : mémoire inchangée.
    expect(deps.store.getCode()).toBe(before);
  });
});
