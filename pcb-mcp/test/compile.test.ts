// S6 — compile.ts pur (frontière module, sans HTTP).
// Valeurs attendues indépendantes : prototype preview-web README (92 éléments,
// 13 composants / 14 traces / 5 nets, ~3-8s) → assertions en fourchettes,
// jamais de recalcul par le code sous test.
import { describe, test, expect } from "bun:test";
import { compileTsx } from "../src/compile";
import { BOARD_CODE, computeStats } from "../src/board";

describe("S6 — compileTsx offline-first", () => {
  test("fixture valide → circuit-json + 0 erreur", async () => {
    const res = await compileTsx(BOARD_CODE);
    expect(res.errors).toBe(0);
    expect(res.diagnostics).toEqual([]);
    expect(res.mode).toBe("worker-blob-local");
    expect(res.banner).toBeNull();
    expect(res.circuitJson.length).toBeGreaterThan(50);
    expect(res.stats.total).toBe(res.circuitJson.length);
    expect(res.stats.components).toBeGreaterThanOrEqual(3);
    expect(res.stats.traces).toBeGreaterThanOrEqual(5);
    expect(res.stats.nets).toBeGreaterThanOrEqual(2);
  }, 60000);

  test("disableCdnLoading → même JSON + bandeau CDN", async () => {
    const res = await compileTsx(BOARD_CODE, { disableCdnLoading: true });
    expect(res.errors).toBe(0);
    expect(res.mode).toBe("worker-blob-local-nocdn");
    expect(res.banner).toMatch(/CDN désactivé/);
    expect(res.circuitJson.length).toBeGreaterThan(50);
  }, 60000);

  test("TSX invalide → diagnostics exploitables, pas de JSON inventé", async () => {
    const res = await compileTsx(`export default () => (<board><resistor name="R1"`);
    expect(res.errors).toBe(1);
    expect(res.circuitJson).toEqual([]);
    expect(res.stats.total).toBe(0);
    expect(res.mode).toBe("echec");
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(res.diagnostics[0]!.message.length).toBeGreaterThan(10);
    expect(res.banner).toMatch(/Échec compilation/);
  }, 60000);

  test("note prototype : entrypoint + export default → erreur mainComponentPath", async () => {
    const { CircuitRunner } = (await import("@tscircuit/eval")) as unknown as {
      CircuitRunner: new (config?: Record<string, unknown>) => {
        executeWithFsMap: (opts: Record<string, unknown>) => Promise<void>;
        renderUntilSettled: () => Promise<void>;
      };
    };
    const runner = new CircuitRunner({ platform: { partsEngineDisabled: true } });
    let message = "";
    try {
      await runner.executeWithFsMap({ fsMap: { "main.tsx": BOARD_CODE }, entrypoint: "main.tsx" });
      await runner.renderUntilSettled();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/no children/i);
  }, 60000);

  test("computeStats compte par type sans recalcul tautologique", () => {
    const stats = computeStats([
      { type: "pcb_component" },
      { type: "source_trace" },
      { type: "source_net" },
      { type: "source_net" },
    ]);
    expect(stats).toMatchObject({ total: 4, components: 1, traces: 1, nets: 2 });
  });
});
