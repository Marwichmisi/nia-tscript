// S8 — live.ts pur (transfos TSX write-through, sans I/O ni compile).
// Valeurs attendues : littéraux indépendants issus de la fixture BOARD_CODE.
import { describe, test, expect } from "bun:test";
import { BOARD_CODE } from "../src/board";
import {
  applyMove,
  applyRotate,
  applySwapPackage,
  applyReassignNet,
  getSelection,
  refuseLiveCreation,
} from "../src/live";

describe("S8 — live.ts pur", () => {
  test("move R1 → pcbX/pcbY réécrits", () => {
    const out = applyMove(BOARD_CODE, "R1", 3, -2);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`name="R1"`);
    expect(out.code).toContain(`pcbX={3}`);
    expect(out.code).toContain(`pcbY={-2}`);
    // R2 inchangé
    expect(out.code).toContain(`name="R2"`);
  });

  test("move refdes inconnu → erreur exploitable", () => {
    const out = applyMove(BOARD_CODE, "R9", 0, 0);
    expect(out.ok).toBe(false);
  });

  test("rotate U1 → pcbRotation ajoutée", () => {
    const out = applyRotate(BOARD_CODE, "U1", 90);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`name="U1"`);
    expect(out.code).toContain(`pcbRotation={90}`);
  });

  test("swap_package R1 → footprint réécrit", () => {
    const out = applySwapPackage(BOARD_CODE, "R1", "0603");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`name="R1"`);
    expect(out.code).toContain(`footprint="0603"`);
    expect(out.code).not.toContain(`resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`);
  });

  test("reassign_net R1 pin1 → net.GND", () => {
    const out = applyReassignNet(BOARD_CODE, "R1", "pin1", "GND");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`net.GND`);
    // La trace d'origine vers VCC a disparu
    expect(out.code).not.toContain(`from=".R1 > .pin1" to="net.VCC"`);
  });

  test("reassign_net pin inconnue → erreur", () => {
    const out = applyReassignNet(BOARD_CODE, "R1", "pin9", "GND");
    expect(out.ok).toBe(false);
  });

  test("select R1 → props + nets", () => {
    const sel = getSelection(BOARD_CODE, "R1");
    expect(sel).not.toBeNull();
    expect(sel!.refdes).toBe("R1");
    expect(sel!.nets).toContain("VCC");
  });

  test("pas de faux positif R1 vs R10", () => {
    const code10 = BOARD_CODE.replace(`name="R2"`, `name="R10"`);
    expect(getSelection(code10, "R1")!.nets).toContain("VCC");
    // R10 n'existe pas dans les traces : aucun net explicite
    const moved = applyMove(code10, "R10", 1, 1);
    expect(moved.ok).toBe(true);
    const bad = applyReassignNet(code10, "R1", "pin1", "GND");
    expect(bad.ok).toBe(true);
  });

  test("création live refusée → renvoi code_patch", () => {
    const msg = refuseLiveCreation("create");
    expect(msg).toMatch(/code_patch/);
  });
});
