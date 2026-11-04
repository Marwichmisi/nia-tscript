// Scénarios T6 au seam AgentChat (SDK réel, MockLanguageModelV4, zéro réseau,
// zéro clé réelle — préfixe FAUSSE-CLE- interdit même en test : on utilise
// des doubles injectés, jamais de clé).

import { describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { createApprovalGate } from "./tools";
import { createAgentConversation, type ConversationDeps } from "./session";

function usageOf() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

/** Construit un flux de parts modèle (streaming réel, multi-tours SDK). */
function streamOf(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  };
}

function textStream(text: string): LanguageModelV4StreamResult {
  return streamOf([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", usage: usageOf(), finishReason: { unified: "stop", raw: "stop" } },
  ]);
}

function lotStream(opInput: unknown, reply: string): LanguageModelV4StreamResult[] {
  const input = JSON.stringify(opInput);
  return [
    streamOf([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Je propose ce lot." },
      { type: "text-end", id: "t1" },
      // Part assemblée (le fournisseur assemble : input en chaîne JSON).
      { type: "tool-call", toolCallId: "call-1", toolName: "batch_execute", input },
      { type: "finish", usage: usageOf(), finishReason: { unified: "tool-calls", raw: "tool-calls" } },
    ]),
    textStream(reply),
  ];
}

const LOT_INPUT = { operations: [{ kind: "move", refdes: "R1", x: 1, y: 2 }] };

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function deps(over: Partial<ConversationDeps> = {}): ConversationDeps {
  return {
    projectPath: "/projets/demo",
    modelId: "muse-spark-1.3",
    storage: memStore(),
    gate: createApprovalGate(),
    // Lecture libre injectée (jamais de réseau) : état carte simulé.
    readBoard: async () => ({ summary: "R1, R2 (2 composants)", mainLines: 12, elements: 2 }),
    executeLot: vi.fn(async () => ({ applied: true, rolledBack: false, errors: 0, message: "lot appliqué", code: null })),
    modelFor: (modelId) =>
      new MockLanguageModelV4({ modelId, provider: "meta-test", doStream: [textStream(`écho ${modelId}`)] }) as never,
    ...over,
  };
}

describe("session AgentChat", () => {
  test("aucun appel sans Projet ouvert (garde G3 avant tout réseau)", async () => {
    const complete = vi.fn();
    const neverModel = (() => { throw new Error("ne doit pas construire"); }) as unknown as ConversationDeps["modelFor"];
    const s = createAgentConversation(deps({ projectPath: null, modelFor: neverModel }));
    await expect(s.send("bonjour")).rejects.toThrow("NO_PROJECT_OPEN");
    expect(complete).not.toHaveBeenCalled();
  });

  test("consentement requis avant le premier envoi (opt-in pré-envoi)", async () => {
    const s = createAgentConversation(deps());
    await s.send("bonjour");
    expect(s.needsConsent).toBe(true);
    expect(s.messages).toHaveLength(0);
    s.giveConsent();
    await s.send("bonjour");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("approval unique par lot : 1 lot proposé → 1 approval → 1 exécution", async () => {
    const executeLot = vi.fn(async () => ({ applied: true, rolledBack: false, errors: 0, message: "lot appliqué", code: null }));
    const s = createAgentConversation(
      deps({
        executeLot,
        modelFor: () =>
          new MockLanguageModelV4({ doStream: lotStream(LOT_INPUT, "lot appliqué, R1 déplacé.") }) as never,
      }),
    );
    s.giveConsent();
    const sending = s.send("déplace R1");
    await vi.waitFor(() => expect(s.pending).toHaveLength(1));
    expect(executeLot).not.toHaveBeenCalled();
    s.approve(s.pending[0]!.toolCallId);
    await sending;
    expect(executeLot).toHaveBeenCalledTimes(1);
    const assistant = s.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ model: "muse-spark-1.3", lot: { applied: true, rolledBack: false } });
    expect(s.pending).toHaveLength(0);
  });

  test("switch mid-conversation : historique partagé, étiquette par message", async () => {
    const s = createAgentConversation(deps());
    s.giveConsent();
    await s.send("question 1");
    s.setModel("muse-spark-1.2");
    await s.send("question 2");
    const assistants = s.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.model)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    expect(s.messages).toHaveLength(4);
  });

  test("compaction à 80 % : résumé + derniers tours, conversation continue", async () => {
    const s = createAgentConversation(deps({ budgetTokens: 40 }));
    s.giveConsent();
    await s.send("un premier message assez long pour remplir le budget");
    await s.send("un deuxième message qui force la compaction du contexte");
    expect(s.messages[0]!.role).toBe("system");
    expect(s.messages.some((m) => m.text.includes("compacté"))).toBe(true);
    expect(s.messages).toHaveLength(3); // résumé + dernier tour intact
    expect(s.messages[s.messages.length - 2]).toMatchObject({ role: "user" });
  });

  test("dégradation sans tool-calling : texte seul, routeur jamais appelé", async () => {
    const executeLot = vi.fn();
    const s = createAgentConversation(
      deps({
        executeLot,
        modelFor: () => new MockLanguageModelV4({ doStream: [textStream("voici la doc, sans toucher la carte.")] }) as never,
      }),
    );
    s.giveConsent();
    await s.send("explique le placement");
    expect(executeLot).not.toHaveBeenCalled();
    expect(s.degraded).toMatch(/texte seul/);
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("modèle sans tool-calling (US10) : texte seul + bandeau explicite, outil jamais offert", async () => {
    const executeLot = vi.fn(async () => ({ applied: true, rolledBack: false, errors: 0, message: "ok", code: null }));
    const s = createAgentConversation(
      deps({
        modelId: "llama3-local",
        executeLot,
        modelFor: () => new MockLanguageModelV4({ doStream: [textStream("voici la doc.")] }) as never,
      }),
    );
    s.giveConsent();
    await s.send("déplace R1");
    expect(executeLot).not.toHaveBeenCalled();
    expect(s.pending).toHaveLength(0);
    expect(s.degraded).toMatch(/ne supporte pas les Lots/);
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("sessionId généralisé : l'id de Conversation isole les lots, stable entre tours", async () => {
    const seen: (string | undefined)[] = [];
    const executeLot = vi.fn(async (input: { sessionId?: string }) => {
      seen.push(input.sessionId);
      return { applied: true, rolledBack: false, errors: 0, message: "lot appliqué", code: null };
    });
    const s = createAgentConversation(
      deps({
        executeLot: executeLot as never,
        modelFor: () =>
          new MockLanguageModelV4({ doStream: lotStream(LOT_INPUT, "lot appliqué.") }) as never,
      }),
    );
    expect(s.conversationId).toBeTruthy();
    s.setMode("auto");
    s.giveConsent();
    await s.send("déplace R1");
    await s.send("puis tourne");
    expect(seen.length).toBeGreaterThan(0);
    for (const id of seen) expect(id).toBe(s.conversationId);
  });

  test("sidecar éteint : échec lot visible (rollback), chat réutilisable", async () => {
    const executeLot = vi
      .fn()
      .mockRejectedValueOnce(new Error("connexion sidecar refusée"))
      .mockResolvedValue({ applied: true, rolledBack: false, errors: 0, message: "ok", code: null });
    const s = createAgentConversation(
      deps({
        executeLot,
        modelFor: () => new MockLanguageModelV4({ doStream: lotStream(LOT_INPUT, "second essai.") }) as never,
      }),
    );
    s.setMode("auto");
    s.giveConsent();
    await s.send("déplace R1");
    const first = s.messages.filter((m) => m.role === "assistant")[0]!;
    expect(first.lot).toMatchObject({ applied: false });
    expect(String(first.lot?.message ?? "")).toMatch(/sidecar|dégradé/i);
    await s.send("réessaie");
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  test("Stop pendant l'approbation puis reprise : aucun doublon, lot appliqué", async () => {
    const executeLot = vi.fn(async () => ({ applied: true, rolledBack: false, errors: 0, message: "ok", code: null }));
    const s = createAgentConversation(
      deps({
        executeLot,
        modelFor: () => new MockLanguageModelV4({ doStream: lotStream(LOT_INPUT, "lot appliqué.") }) as never,
      }),
    );
    s.giveConsent();
    const sending = s.send("déplace R1");
    await vi.waitFor(() => expect(s.pending).toHaveLength(1));
    s.stop();
    await sending;
    expect(executeLot).not.toHaveBeenCalled();
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    const resuming = s.resume();
    await vi.waitFor(() => expect(s.pending).toHaveLength(1));
    s.approve(s.pending[0]!.toolCallId);
    await resuming;
    await vi.waitFor(() => expect(executeLot).toHaveBeenCalledTimes(1));
    expect(s.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});
