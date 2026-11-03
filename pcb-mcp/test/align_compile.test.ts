// Ticket #39 — compile alignée : pinning, diagnostics embarqués, gates DRC.
// Tests purs et rapides (aucune compile, aucune I/O réseau) :
//   1. contrat de pinning exact commun (-saveurs satellites) ;
//   2. extracteur de diagnostics embarqués du circuit-json (synthétique).
// Valeurs indépendantes : littéraux écrits à la main, jamais recalculés
// par le code sous test.
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import { extractEmbeddedDiagnostics } from "../src/compile";

// Socle commun des deux moteurs : cœur, vérifications, footprinter et
// convertisseurs (fini la dérive des satellites).
const SHARED_PINNED = [
  "@tscircuit/core",
  "@tscircuit/eval",
  "@tscircuit/checks",
  "@tscircuit/footprinter",
  "@tscircuit/props",
  "circuit-json-to-gerber",
  "circuit-json-to-bom-csv",
  "circuit-json-to-pnp-csv",
  "circuit-json-to-kicad",
  "kicad-to-circuit-json",
  "jszip",
];

describe("#39 — pinning exact commun des deux moteurs", () => {
  test("dépendances partagées épinglées exact, identiques des deux côtés", () => {
    const mcpPkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const frontPkg = JSON.parse(
      fs.readFileSync(new URL("../../src/package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const dep of SHARED_PINNED) {
      expect(mcpPkg.dependencies[dep], `pcb-mcp:${dep}`).toBeDefined();
      expect(frontPkg.dependencies[dep], `src:${dep}`).toBeDefined();
      expect(mcpPkg.dependencies[dep], `pcb-mcp:${dep} exact`).not.toMatch(/^[\^~]/);
      expect(frontPkg.dependencies[dep], `src:${dep} exact`).not.toMatch(/^[\^~]/);
      expect(frontPkg.dependencies[dep], `${dep} aligné`).toBe(mcpPkg.dependencies[dep]);
    }
  });
});

describe("#39 — diagnostics embarqués du circuit-json", () => {
  test("circuit-json sain → aucun diagnostic", () => {
    const diags = extractEmbeddedDiagnostics([
      { type: "source_component", source_component_id: "sc1" },
      { type: "pcb_component", source_component_id: "sc1" },
      { type: "source_trace", source_trace_id: "st1" },
    ]);
    expect(diags).toEqual([]);
  });

  test("élément type *_error → diagnostic error réel", () => {
    const diags = extractEmbeddedDiagnostics([
      { type: "source_component", source_component_id: "sc1" },
      {
        type: "schematic_error",
        schematic_error_id: "se0",
        message: "court-circuit net VCC",
      },
    ]);
    expect(diags.length).toBe(1);
    expect(diags[0]).toMatchObject({ severity: "error", source: "circuit-json" });
    expect(diags[0]!.message).toMatch(/court-circuit net VCC/);
  });

  test("élément type *_warning → diagnostic warning réel", () => {
    const diags = extractEmbeddedDiagnostics([
      {
        type: "pcb_placement_warning",
        message: "composant R9 hors contour",
      },
    ]);
    expect(diags.length).toBe(1);
    expect(diags[0]).toMatchObject({ severity: "warning", source: "circuit-json" });
    expect(diags[0]!.message).toMatch(/R9 hors contour/);
  });

  test("champ error_message → error même sans type error", () => {
    const diags = extractEmbeddedDiagnostics([
      { type: "pcb_component", error_message: "empreinte introuvable" },
    ]);
    expect(diags.length).toBe(1);
    expect(diags[0]).toMatchObject({ severity: "error", source: "circuit-json" });
    expect(diags[0]!.message).toMatch(/empreinte introuvable/);
  });

  test("compteurs derivés : 2 erreurs + 1 warning", () => {
    const diags = extractEmbeddedDiagnostics([
      { type: "schematic_error", message: "e1" },
      { type: "pcb_error", message: "e2" },
      { type: "pcb_warning", message: "w1" },
      { type: "pcb_component" },
    ]);
    expect(diags.filter((d) => d.severity === "error").length).toBe(2);
    expect(diags.filter((d) => d.severity === "warning").length).toBe(1);
  });

  test("sous-chaîne error sans suffixe _error → aucun diagnostic (faux positif #review-1)", () => {
    const diags = extractEmbeddedDiagnostics([
      { type: "error_report" },
      { type: "pcb_errorenous_flag" },
      { type: "myerrorhandler" },
    ]);
    expect(diags).toEqual([]);
  });

  test("sous-chaîne warning sans suffixe _warning → aucun diagnostic (faux positif #review-1)", () => {
    const diags = extractEmbeddedDiagnostics([
      { type: "warning_track" },
      { type: "warnings_enabled" },
      { type: "mywarninghandler" },
    ]);
    expect(diags).toEqual([]);
  });

  test("cas réels validés : suffixe _error/_warning + casse mixte + type nu", () => {
    const diags = extractEmbeddedDiagnostics([
      { type: "source_invalid_component_property_error", message: "bad prop" },
      { type: "pcb_footprint_overlap_error", message: "overlap" },
      { type: "PCB_ERROR", message: "majuscules" },
      { type: "error", message: "nu" },
      { type: "WARNING", message: "nu warning" },
    ]);
    expect(diags.filter((d) => d.severity === "error").length).toBe(4);
    expect(diags.filter((d) => d.severity === "warning").length).toBe(1);
  });
});
