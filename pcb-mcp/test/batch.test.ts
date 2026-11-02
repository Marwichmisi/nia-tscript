// S10 — batch.ts pur (moteur atomique, sans I/O ni compile).
// Valeurs attendues : littéraux indépendants issus de la fixture BOARD_CODE.
import { describe, test, expect } from "bun:test";
import { BOARD_CODE } from "../src/board";
import { applyBatch } from "../src/batch";

describe("S10 — batch.ts pur", () => {
  test("lot mixte valide patch + move → code final combiné", () => {
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
    expect(out.code).toContain(`pcbY={-2}`);
  });

  test("patch introuvable → échec index 0, message exploitable", () => {
    const out = applyBatch(BOARD_CODE, [
      { kind: "patch", anchor: "X-INTROUVABLE-999", replacement: "y" },
      { kind: "move", refdes: "R1", x: 1, y: 1 },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failedIndex).toBe(0);
    expect(out.message).toMatch(/introuvable/);
  });

  test("seconde op invalide → échec index 1", () => {
    const out = applyBatch(BOARD_CODE, [
      {
        kind: "patch",
        anchor: `resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`,
        replacement: `resistance="4.7k" footprint="0402" pcbX={-5} pcbY={4}`,
      },
      { kind: "move", refdes: "R9", x: 1, y: 1 },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failedIndex).toBe(1);
    expect(out.message).toMatch(/R9/);
  });

  test("lot vide → refusé", () => {
    const out = applyBatch(BOARD_CODE, []);
    expect(out.ok).toBe(false);
  });

  test("rotate + swap_package + reassign_net enchaînés → ok", () => {
    const out = applyBatch(BOARD_CODE, [
      { kind: "rotate", refdes: "U1", degrees: 90 },
      { kind: "swap_package", refdes: "R1", footprint: "0603" },
      { kind: "reassign_net", refdes: "R1", pin: "pin1", net: "GND" },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`pcbRotation={90}`);
    expect(out.code).toContain(`footprint="0603"`);
    expect(out.code).toContain(`net.GND`);
  });
});
