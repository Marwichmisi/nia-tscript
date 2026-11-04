// Couture S4 (tool + approbation) : 1 approval = 1 lot.
// Zéro réseau, routeur injecté (double en test).

import { describe, expect, test, vi } from "vitest";
import {
  createApprovalGate,
  createBatchExecuteTool,
  type LotOutcome,
} from "./tools";
import type { BatchExecuteToolInput } from "./schemas";

const LOT: BatchExecuteToolInput = { operations: [{ kind: "move", refdes: "R1", x: 1, y: 2 }] };

function okOutcome(): LotOutcome {
  return { applied: true, rolledBack: false, errors: 0, message: "lot appliqué", code: null };
}

describe("batch_execute + approbation", () => {
  test("mode manuel : suspend jusqu'à approve, exécute une fois", async () => {
    const gate = createApprovalGate();
    const exec = vi.fn(async () => okOutcome());
    const tool = createBatchExecuteTool({ gate, execute: exec, getMode: () => "manuel" });
    const pending = tool.execute!(LOT, { toolCallId: "c1", abortSignal: undefined } as never);
    expect(exec).not.toHaveBeenCalled();
    expect(gate.list()).toHaveLength(1);
    expect(gate.list()[0]).toMatchObject({ toolCallId: "c1" });
    gate.approve("c1");
    const out = await pending;
    expect(exec).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ applied: true, rolledBack: false });
  });

  test("refus → routeur jamais appelé, sortie applied:false explicite", async () => {
    const gate = createApprovalGate();
    const exec = vi.fn(async () => okOutcome());
    const tool = createBatchExecuteTool({ gate, execute: exec, getMode: () => "manuel" });
    const pending = tool.execute!(LOT, { toolCallId: "c2", abortSignal: undefined } as never);
    gate.reject("c2", "trop risqué");
    const out = await pending;
    expect(exec).not.toHaveBeenCalled();
    expect(out).toMatchObject({ applied: false, rejected: true });
  });

  test("mode auto : exécute sans approbation (suppression toujours manuelle : aucun op delete)", async () => {
    const gate = createApprovalGate();
    const exec = vi.fn(async () => okOutcome());
    const tool = createBatchExecuteTool({ gate, execute: exec, getMode: () => "auto" });
    const out = await tool.execute!(LOT, { toolCallId: "c3", abortSignal: undefined } as never);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(gate.list()).toHaveLength(0);
    expect(out).toMatchObject({ applied: true });
  });

  test("rollback visible en échec (applied:false, rolledBack:true, message)", async () => {
    const gate = createApprovalGate();
    const exec = vi.fn(async (): Promise<LotOutcome> => ({
      applied: false,
      rolledBack: true,
      errors: 1,
      message: "routing refusé : placement non vert",
      code: null,
    }));
    const tool = createBatchExecuteTool({ gate, execute: exec, getMode: () => "auto" });
    const out = await tool.execute!(LOT, { toolCallId: "c4", abortSignal: undefined } as never);
    expect(out).toMatchObject({ applied: false, rolledBack: true });
    expect(String((out as { message: string }).message)).toContain("placement non vert");
  });

  test("lot vide → refusé avant routeur", async () => {
    const gate = createApprovalGate();
    const exec = vi.fn(async () => okOutcome());
    const tool = createBatchExecuteTool({ gate, execute: exec, getMode: () => "auto" });
    const out = await tool.execute!({ operations: [] }, { toolCallId: "c5", abortSignal: undefined } as never);
    expect(exec).not.toHaveBeenCalled();
    expect(out).toMatchObject({ applied: false });
  });

  test("Stop pendant l'attente → AbortError, routeur jamais appelé", async () => {
    const gate = createApprovalGate();
    const exec = vi.fn(async () => okOutcome());
    const tool = createBatchExecuteTool({ gate, execute: exec, getMode: () => "manuel" });
    const ctrl = new AbortController();
    const pending = tool.execute!(LOT, { toolCallId: "c6", abortSignal: ctrl.signal } as never);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(exec).not.toHaveBeenCalled();
  });

  test("double approve = une seule exécution (1 approval = 1 lot)", async () => {
    const gate = createApprovalGate();
    const exec = vi.fn(async () => okOutcome());
    const tool = createBatchExecuteTool({ gate, execute: exec, getMode: () => "manuel" });
    const pending = tool.execute!(LOT, { toolCallId: "c7", abortSignal: undefined } as never);
    gate.approve("c7");
    gate.approve("c7");
    await pending;
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
