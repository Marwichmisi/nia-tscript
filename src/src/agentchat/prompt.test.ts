// Instructions système (pures, testées) : cadrage du modèle pour le lot
// unique. Le modèle ne voit qu'UN tool (`batch_execute`) ; les lectures
// (état carte, hiérarchie) sont injectées en contexte par la session
// (opérations internes invisibles).

import { describe, expect, test } from "vitest";
import { buildInstructions } from "./prompt";

describe("instructions système", () => {
  test("un seul tool exposé, suppression interdite, lot unique", () => {
    const ix = buildInstructions({ boardSummary: "R1, R2 (2 composants)" });
    expect(ix).toContain("batch_execute");
    expect(ix).toContain("R1, R2");
    expect(ix).toMatch(/suppression/i);
    expect(ix).toContain("```batch_execute");
  });
});
