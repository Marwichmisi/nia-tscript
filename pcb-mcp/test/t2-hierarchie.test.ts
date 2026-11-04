// T2 (I10, #59) — hiérarchie dynamique + board isolé au Projet.
//
// Seam S3 (ressource `pcb://hierarchy` / `readHierarchy`) : la hiérarchie
// reflète le TSX/circuit-json courant (plus de fixture R1/C1), le nom de
// board est isolé au Projet ouvert, aucune lecture hors Projet (Confinement).
import { describe, test, expect } from "bun:test";
import { createMemoryStore } from "../src/tools-core/store";
import { emptyRegistry } from "../src/tools-core/project-core";
import { OUT_OF_SCOPE, NO_PROJECT_OPEN } from "../src/tools-core/project-core";
import type { ToolsDeps } from "../src/tools-core/deps";
import { readHierarchy } from "../src/tools-core/tools";

const CUSTOM_CODE = `export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R5" resistance="4.7k" footprint="0603" pcbX={-5} pcbY={4} />
    <resistor name="R6" resistance="10k" footprint="0402" pcbX={5} pcbY={-4} />
  </board>
)
`;

function makeDeps(opts: {
  code?: string;
  project?: string | null;
  member?: boolean;
  board?: string;
}): ToolsDeps {
  const store = createMemoryStore(opts.code ?? CUSTOM_CODE);
  const proj = opts.project === undefined ? "/projets/demo" : opts.project;
  return {
    resolveProject: () => proj,
    assertMember: (p) => {
      if (opts.member === false) throw new Error(`hors périmètre (Confinement) : ${p}`);
      if (p !== "/projets/demo") throw new Error(`hors périmètre (Confinement) : ${p}`);
      return p;
    },
    boardName: () => opts.board ?? "demo",
    compile: (async () => {
      throw new Error("pas de compile dans ce test");
    }) as unknown as ToolsDeps["compile"],
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

type HierarchyJson = {
  board: string;
  sessionId?: string;
  modules: Array<{
    name: string;
    components: Array<{ refdes: string; pkg: string; value: string }>;
  }>;
  error?: string;
};

describe("T2 I10 — hiérarchie dynamique, board isolé, Confinement", () => {
  test("S3 reflète le TSX courant (R5/R6), plus de fixture R1/C1", () => {
    const deps = makeDeps({});
    const { json } = readHierarchy(deps);
    const h = json as HierarchyJson;
    const refdes = h.modules[0]!.components.map((c) => c.refdes).sort();
    expect(refdes).toEqual(["R5", "R6"]);
    expect(refdes).not.toContain("C1");
    const r5 = h.modules[0]!.components.find((c) => c.refdes === "R5")!;
    expect(r5.pkg).toBe("0603");
    expect(r5.value).toBe("4.7k");
  });

  test("S3 board isolé au Projet ouvert (basename, pas de fuite)", () => {
    const deps = makeDeps({ board: "mon-projet" });
    const { json } = readHierarchy(deps);
    expect((json as HierarchyJson).board).toBe("mon-projet");
  });

  test("S3 sans Projet → NO_PROJECT_OPEN, aucune lecture", () => {
    const deps = makeDeps({ project: null });
    const { json } = readHierarchy(deps);
    expect((json as { error?: string }).error).toBe(NO_PROJECT_OPEN);
  });

  test("S3 hors périmètre → OUT_OF_SCOPE, aucune lecture hors Projet", () => {
    const deps = makeDeps({ member: false });
    const { json } = readHierarchy(deps);
    const text = JSON.stringify(json);
    expect(text).toContain(OUT_OF_SCOPE);
    expect(text).not.toContain("R5");
  });
});
