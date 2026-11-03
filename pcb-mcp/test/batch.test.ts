// S10 — batch.ts pur (moteur atomique, sans I/O ni compile).
// Valeurs attendues : littéraux indépendants issus de la fixture BOARD_CODE.
import { describe, test, expect } from "bun:test";
import { BOARD_CODE } from "../src/board";
import { applyBatch } from "../src/batch";
import { boardExpectsRouting, boardRoutingDisabled, isBoardRouted } from "../src/board";

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

describe("S10 — op route pure (ticket #44)", () => {
  test("route sans effort → autorouter local + effort défaut 1x", () => {
    const out = applyBatch(BOARD_CODE, [{ kind: "route" }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`autorouter="auto_local"`);
    expect(out.code).toContain(`autorouterEffortLevel="1x"`);
  });

  test("route effort 10x → niveau propagé sur le tag board", () => {
    const out = applyBatch(BOARD_CODE, [{ kind: "route", effort: "10x" }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`autorouter="auto_local"`);
    expect(out.code).toContain(`autorouterEffortLevel="10x"`);
  });

  test("route idempotent : re-route 10x après 1x → une seule config, valeur remplacée", () => {
    const first = applyBatch(BOARD_CODE, [{ kind: "route", effort: "1x" }]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyBatch(first.code, [{ kind: "route", effort: "10x" }]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.code).not.toContain(`autorouterEffortLevel="1x"`);
    expect(second.code).toContain(`autorouterEffortLevel="10x"`);
    expect(second.code.split(`autorouter="auto_local"`).length - 1).toBe(1);
  });

  test("route combinée avec move → lot mixte ok", () => {
    const out = applyBatch(BOARD_CODE, [
      { kind: "route", effort: "2x" },
      { kind: "move", refdes: "R1", x: 3, y: -2 },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toContain(`autorouterEffortLevel="2x"`);
    expect(out.code).toContain(`pcbX={3}`);
  });

  test("route effort invalide → échec index 0, message exploitable", () => {
    const out = applyBatch(BOARD_CODE, [{ kind: "route", effort: "99x" as never }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failedIndex).toBe(0);
    expect(out.message).toMatch(/effort/);
  });

  test("route sans tag board → échec explicite", () => {
    const out = applyBatch(`export default () => null`, [{ kind: "route" }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failedIndex).toBe(0);
    expect(out.message).toMatch(/board/);
  });

  test("isBoardRouted : faux sur vide, vrai sur circuit-json routé", () => {
    expect(isBoardRouted([])).toBe(false);
    expect(isBoardRouted([{ type: "pcb_trace", route: [] }])).toBe(false);
    expect(
      isBoardRouted([{ type: "pcb_trace", route: [{ route_type: "wire", x: 0, y: 0 }] }]),
    ).toBe(true);
  });

  test("boardRoutingDisabled : détecte routingDisabled sur le tag board", () => {
    expect(boardRoutingDisabled(BOARD_CODE)).toBe(false);
    expect(boardRoutingDisabled(BOARD_CODE.replace(`<board width=`, `<board routingDisabled width=`))).toBe(
      true,
    );
  });

  test("boardExpectsRouting : commentaire // <trace → pas de routage attendu (#review-2)", () => {
    const onlyComment = `export default () => (
  // <trace from=".R1 > .pin1" to="net.VCC" />
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />
  </board>
)`;
    expect(boardExpectsRouting(onlyComment)).toBe(false);
    const blockComment = `export default () => (
  <board width="20mm" height="20mm">
    {/* <trace from=".R1 > .pin1" to="net.VCC" /> */}
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />
  </board>
)`;
    expect(boardExpectsRouting(blockComment)).toBe(false);
    expect(boardExpectsRouting(BOARD_CODE)).toBe(true);
  });

  test("boardRoutingDisabled : commentaire routingDisabled → pas d'interdit (#review-2)", () => {
    const lineComment = `// routingDisabled\nexport default () => (\n  <board width="20mm" height="20mm">\n  </board>\n)`;
    expect(boardRoutingDisabled(lineComment)).toBe(false);
    const blockComment = `export default () => (\n  /* routingDisabled */\n  <board width="20mm" height="20mm">\n  </board>\n)`;
    expect(boardRoutingDisabled(blockComment)).toBe(false);
    const commentInTag = BOARD_CODE.replace(`<board width=`, `<board /* routingDisabled */ width=`);
    expect(boardRoutingDisabled(commentInTag)).toBe(false);
    expect(
      boardRoutingDisabled(BOARD_CODE.replace(`<board width=`, `<board routingDisabled width=`)),
    ).toBe(true);
  });
});
