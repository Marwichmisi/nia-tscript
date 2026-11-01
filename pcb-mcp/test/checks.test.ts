// S7-A1 — checks natifs purs (seam A) : fixture valide → vert.
// Valeurs indépendantes : BOARD_CODE (fixture R1/R2+U1 du prototype) doit
// donner 0 violation native, placement vert, routing autorisé.
import { describe, test, expect } from "bun:test";
import { BOARD_CODE, BOARD_INVALID_PLACEMENT } from "../src/board";
import { compileTsx } from "../src/compile";
import { runDomainChecks, runPlacementGate } from "../src/checks";

describe("S7-A1 — gate placement sur fixture valide", () => {
  test("fixture valide → placement vert, routing autorisé, 0 violation", async () => {
    const compiled = await compileTsx(BOARD_CODE);
    expect(compiled.errors).toBe(0);
    const gate = await runPlacementGate(compiled.circuitJson, BOARD_CODE);
    expect(gate.placementGreen).toBe(true);
    expect(gate.routingAllowed).toBe(true);
    expect(gate.missingCoords).toEqual([]);
    expect(gate.placementViolations).toEqual([]);
  }, 60000);

  test("fixture overlap R1/R2 → placement non vert, routing bloqué, violation positionnée", async () => {
    const compiled = await compileTsx(BOARD_INVALID_PLACEMENT);
    expect(compiled.errors).toBe(0);
    const gate = await runPlacementGate(compiled.circuitJson, BOARD_INVALID_PLACEMENT);
    expect(gate.placementGreen).toBe(false);
    expect(gate.routingAllowed).toBe(false);
    expect(gate.blockReason).toMatch(/placement non vert/);
    expect(gate.placementViolations.length).toBeGreaterThanOrEqual(1);
    expect(gate.placementViolations[0]!.message.length).toBeGreaterThan(10);
    const routing = await runDomainChecks(compiled.circuitJson, "routing");
    expect(routing.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  test("composant sans pcbX/pcbY → gate bloque avec coords explicites exigées", async () => {
    const sansCoords = BOARD_CODE.replace(` pcbX={-5} pcbY={4}`, ``);
    expect(sansCoords).not.toContain(`R1" resistance="10k" footprint="0402" pcbX`);
    const compiled = await compileTsx(sansCoords);
    expect(compiled.errors).toBe(0);
    const gate = await runPlacementGate(compiled.circuitJson, sansCoords);
    expect(gate.missingCoords).toContain("R1");
    expect(gate.placementGreen).toBe(false);
    expect(gate.routingAllowed).toBe(false);
    expect(gate.blockReason).toMatch(/coordonnées explicites manquantes.*R1/);
  }, 60000);
});
