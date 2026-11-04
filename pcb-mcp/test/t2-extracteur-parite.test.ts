// T2 (I9, #59) — parité extracteurs diagnostics front/sidecar.
//
// Seam S6 (comptes errors/warnings) : l'extracteur front
// (`src/src/lib/compile.ts`) applique la même regex stricte que le sidecar
// (`/(^|_)error$/`, `/(^|_)warning$/`) — la sous-chaîne nue (ex
// `error_report`) ne compte plus, les comptes/gates sont cohérents des deux
// côtés. Le code front réel est extrait de son fichier source et exécuté
// (même comptage sur les mêmes vecteurs), pas recopié.
import { describe, test, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractEmbeddedDiagnostics as core } from "../src/tools-core/diagnostics";

type Diag = { severity: string; message: string; source: string };
type FrontFn = (circuitJson: unknown[]) => Diag[];

const FRONT_PATH = new URL(
  "../../src/src/lib/compile.ts",
  import.meta.url,
);

function loadFrontFn(): Promise<FrontFn> {
  const src = fs.readFileSync(FRONT_PATH, "utf8");
  const start = src.indexOf("export function extractEmbeddedDiagnostics");
  if (start < 0) throw new Error("extracteur front introuvable dans src/src/lib/compile.ts");
  const end = src.indexOf("function toCounts", start);
  if (end < 0) throw new Error("fin d'extracteur front introuvable");
  const fnSrc = src.slice(start, end);
  // Garde : le front ne doit plus utiliser la version large.
  expect(fnSrc).not.toMatch(/\.includes\(\s*["']error["']\s*\)/);
  expect(fnSrc).not.toMatch(/\.includes\(\s*["']warning["']\s*\)/);
  expect(fnSrc).toMatch(/\/\(\^\|_\)error\$\//);
  expect(fnSrc).toMatch(/\/\(\^\|_\)warning\$\//);
  const modSrc =
    `export interface Diagnostic { severity: "error" | "warning" | "info"; message: string; source: string }\n` +
    fnSrc;
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "nia-t2-i9-")),
    "front-extract.ts",
  );
  fs.writeFileSync(tmp, modSrc);
  return import(pathToFileURL(tmp).href).then((m) => {
    const fn = (m as { extractEmbeddedDiagnostics: FrontFn }).extractEmbeddedDiagnostics;
    expect(typeof fn).toBe("function");
    return fn;
  });
}

let front: FrontFn;
beforeAll(async () => {
  front = await loadFrontFn();
});

const VECTORS: Array<{ name: string; cj: unknown[] }> = [
  { name: "sain", cj: [{ type: "source_component" }, { type: "pcb_component" }] },
  { name: "error suffixe", cj: [{ type: "schematic_error", message: "court-circuit" }] },
  { name: "warning suffixe", cj: [{ type: "pcb_placement_warning", message: "hors contour" }] },
  { name: "error_report nu", cj: [{ type: "error_report" }] },
  { name: "warning_track nu", cj: [{ type: "warning_track" }] },
  { name: "champ explicite", cj: [{ type: "autre", error_message: "boom" }] },
  {
    name: "mixte",
    cj: [
      { type: "schematic_error", message: "e1" },
      { type: "pcb_error", message: "e2" },
      { type: "pcb_warning", message: "w1" },
      { type: "pcb_component" },
      { type: "error_report" },
    ],
  },
  { name: "casse mixte", cj: [{ type: "PCB_ERROR", message: "maj" }, { type: "Error", message: "nu" }] },
];

function counts(fn: (cj: unknown[]) => Diag[], cj: unknown[]): { errors: number; warnings: number } {
  const diags = fn(cj);
  return {
    errors: diags.filter((d) => d.severity === "error").length,
    warnings: diags.filter((d) => d.severity === "warning").length,
  };
}

describe("T2 I9 — parité extracteurs front/sidecar", () => {
  test("S6 même comptage errors/warnings des deux côtés sur chaque vecteur", () => {
    for (const v of VECTORS) {
      expect(counts(front, v.cj), `front:${v.name}`).toEqual(counts(core, v.cj));
    }
  });

  test("S6 error_report (sous-chaîne nue) ignoré des deux côtés", () => {
    expect(counts(front, [{ type: "error_report" }])).toEqual({ errors: 0, warnings: 0 });
    expect(counts(core, [{ type: "error_report" }])).toEqual({ errors: 0, warnings: 0 });
  });
});
