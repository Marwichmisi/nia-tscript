// T2 (I7/I8, #59) — export fab : refus explicite sur Projet vide.
//
// Seam S1 (outil `fab_export`) + S2 (`exportFab` pur) : le comportement
// externe attendu est le REFUS (ready=false / ok=false) avec un message
// explicite « board vide (0 composant) », jamais de gerbers silencieux.
// Valeurs indépendantes : littéraux écrits à la main (audit #51 §I7/I8).
import { describe, test, expect } from "bun:test";
import { exportFab } from "../src/tools-core/fab";
import { extractEmbeddedDiagnostics } from "../src/tools-core/diagnostics";
import {
  emptyStats,
  type CircuitStats,
} from "../src/tools-core/board";
import { createMemoryStore } from "../src/tools-core/store";
import { emptyRegistry } from "../src/tools-core/project-core";
import type { ToolsDeps } from "../src/tools-core/deps";
import type { CompileResult } from "../src/tools-core/diagnostics";
import { runFabExport } from "../src/tools-core/tools";

// Circuit-json minimal d'un board vide : que des métadonnées, 0 composant,
// 0 diagnostic embarqué (miroir de compileTsx(EMPTY_CODE) constaté).
const EMPTY_CIRCUIT_JSON: unknown[] = [
  { type: "source_project_metadata" },
  { type: "source_group" },
  { type: "source_board" },
  { type: "schematic_group" },
  { type: "pcb_board" },
];

const EMPTY_STATS: CircuitStats = {
  total: 5,
  components: 0,
  traces: 0,
  nets: 0,
  byType: {},
};

function compileEmpty(): Promise<CompileResult> {
  return Promise.resolve({
    circuitJson: EMPTY_CIRCUIT_JSON,
    diagnostics: [],
    stats: EMPTY_STATS,
    mode: "worker-blob-local",
    banner: null,
    errors: 0,
    warnings: 0,
  });
}

function makeDeps(): ToolsDeps {
  const store = createMemoryStore(`export default () => (
  <board width="20mm" height="20mm" />
)
`);
  return {
    resolveProject: () => "/projets/demo",
    assertMember: (p) => {
      if (p !== "/projets/demo") throw new Error(`hors périmètre (Confinement) : ${p}`);
      return p;
    },
    boardName: () => "demo",
    compile: compileEmpty,
    persist: () => {},
    fetchFn: (async () => {
      throw new Error("pas de réseau dans ce test");
    }) as unknown as ToolsDeps["fetchFn"],
    log: () => {},
    io: {
      canonicalize: (p) => p,
      ensureLayout: () => "exists",
      ensureCircuitFile: () => "exists",
      dirExists: () => true,
      mainExists: () => true,
      readMain: () => "",
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
    store,
  };
}

describe("T2 I7 — board vide : refus explicite, jamais de gerbers silencieux", () => {
  test("S2 exportFab pur : 0 composant → refus board vide", async () => {
    const out = await exportFab(EMPTY_CIRCUIT_JSON);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("attendu refus");
    expect(out.message).toMatch(/0 composant|board vide/i);
  });

  test("S2 exportFab pur : erreur embarquée → refus compile (I8, resistor sans props)", async () => {
    const cj: unknown[] = [
      { type: "source_project_metadata" },
      {
        type: "source_failed_to_create_component_error",
        message: "Invalid props for resistor \"R1\": resistance (Required)",
      },
    ];
    // Sanity : l'extracteur strict voit bien l'erreur.
    expect(extractEmbeddedDiagnostics(cj).length).toBe(1);
    const out = await exportFab(cj);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("attendu refus");
    expect(out.message).toMatch(/compile en erreur|erreur/i);
  });

  test("S1 outil fab_export : Projet vide → ready=false, message board vide", async () => {
    const deps = makeDeps();
    const out = await runFabExport(deps, {});
    expect(out.output.ready).toBe(false);
    expect(out.output.errors).toBeGreaterThanOrEqual(1);
    expect(String(out.output.message ?? "")).toMatch(/0 composant|board vide/i);
    expect(out.output.exportDir).toBe("");
    expect(out.output.artifacts).toEqual([]);
  });
});
