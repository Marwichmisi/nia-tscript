// S9-B pur — fab exports V1 (frontière module fab.ts, sans HTTP).
// Valeurs indépendantes : fixture R1/R2+U1 → 10 fichiers gerber (F_Cu…,
// drill), BOM 3 lignes (R1/R2/U1), PnP 3 lignes, KiCad (kicad_pcb /
// kicad_sch), zips ouvrables via JSZip. Jamais de recalcul par le code.
import { describe, test, expect } from "bun:test";
import { compileTsx } from "../src/compile";
import { exportFab } from "../src/fab";
import { BOARD_CODE } from "../src/board";

describe("S9-B — fab.exportFab pur", () => {
  test("fixture → gerbers + BOM + PnP + KiCad, zips ouvrables", async () => {
    const compiled = await compileTsx(BOARD_CODE);
    expect(compiled.errors).toBe(0);
    const out = await exportFab(compiled.circuitJson as never[], { projectName: "nia-demo" });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("attendu ok");
    // Gerbers : 10 fichiers, RS-274X valides (en-tête + fin M02*).
    expect(out.gerberNames.length).toBe(10);
    expect(out.gerberNames).toContain("F_Cu.gbr");
    expect(out.gerberNames).toContain("Edge_Cuts.gbr");
    expect(out.gerberPreview).toMatch(/%TF\.|%FS/);
    for (const [name, content] of Object.entries(out.gerberFiles)) {
      if (name.endsWith(".gbr")) expect(content.trimEnd().endsWith("M02*")).toBe(true);
    }
    // BOM : R1/R2/U1.
    expect(out.bomCsv).toMatch(/Designator/);
    expect(out.bomCsv).toMatch(/R1/);
    expect(out.bomCsv).toMatch(/R2/);
    expect(out.bomCsv).toMatch(/U1/);
    expect(out.counts.bomRows).toBe(3);
    // PnP : 3 lignes + en-tête.
    expect(out.pnpCsv).toMatch(/Designator/);
    expect(out.pnpCsv).toMatch(/R1/);
    expect(out.counts.pnpRows).toBe(3);
    // KiCad silencieux : sorties ouvrables.
    expect(out.kicadPcb).toMatch(/\(kicad_pcb/);
    expect(out.kicadSch).toMatch(/\(kicad_sch/);
    expect(out.kicadPcbPreview.length).toBeGreaterThan(10);
    // Round-trip : le .kicad_pcb se ré-importe (lib inverse, pas de tautologie).
    const { KicadToCircuitJsonConverter } = await import("kicad-to-circuit-json");
    const back = new KicadToCircuitJsonConverter();
    back.addFile(`${out.projectName}.kicad_pcb`, out.kicadPcb);
    back.runUntilFinished();
    const backJson = back.getOutput() as Array<{ type?: string }>;
    expect(backJson.filter((e) => e.type === "pcb_component").length).toBe(3);
    expect(back.getWarnings()).toEqual([]);
    // Zips : tailles > 0, contenus attendus.
    expect(out.kicadZipBytes).toBeGreaterThan(500);
    expect(out.fabZipBytes).toBeGreaterThan(500);
    const JSZip = (await import("jszip")).default;
    const kicadZip = await JSZip.loadAsync(Buffer.from(out.kicadZipBase64, "base64"));
    expect(Object.keys(kicadZip.files).join(",")).toMatch(/kicad_pcb/);
    const fabZip = await JSZip.loadAsync(Buffer.from(out.fabZipBase64, "base64"));
    const names = Object.keys(fabZip.files).join(",");
    expect(names).toMatch(/F_Cu\.gbr/);
    expect(names).toMatch(/bom\.csv|bill-of-materials\.csv/i);
    expect(names).toMatch(/pick-and-place\.csv|pnp\.csv/i);
  }, 90000);

  test("circuitJson vide → erreur exploitable, rien d'inventé", async () => {
    const out = await exportFab([], { projectName: "nia-demo" });
    expect(out.ok).toBe(false);
  });
});
