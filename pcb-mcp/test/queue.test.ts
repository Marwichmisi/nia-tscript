// S8-C — file sérialisée (queue pure, sans MCP).
// Prouve l'ordre de drainage : deux tâches concurrentes avec délai
// artificiel s'exécutent dans l'ordre d'enfilement.
import { describe, test, expect } from "bun:test";
import { enqueue, resetQueueForTests } from "../src/queue";

describe("S8-C — file sérialisée", () => {
  test("deux tâches concurrentes → ordre d'arrivée, pas d'entrelacement", async () => {
    resetQueueForTests();
    const order: string[] = [];
    const slow = enqueue(async () => {
      order.push("slow-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("slow-end");
      return "slow";
    });
    const fast = enqueue(async () => {
      order.push("fast");
      return "fast";
    });
    const [s, f] = await Promise.all([slow, fast]);
    expect(s).toBe("slow");
    expect(f).toBe("fast");
    expect(order).toEqual(["slow-start", "slow-end", "fast"]);
  });

  test("une tâche en échec ne bloque pas la file", async () => {
    resetQueueForTests();
    const failing = enqueue(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const next = await enqueue(async () => "ok");
    expect(next).toBe("ok");
  });
});
