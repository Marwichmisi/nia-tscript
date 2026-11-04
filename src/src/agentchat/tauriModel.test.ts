// Couture S3 (modèle) : wrapper LanguageModelV4 sur la commande T4.
// Zéro réseau en test (complete injecté), AbortSignal honoré.

import { describe, expect, test, vi } from "vitest";
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { TauriMetaModel, serializePrompt, type CompleteFn } from "./tauriModel";

const TEXT_ONLY = "Voici comment placer R1 : ouvre le TSX et …";
const WITH_LOT =
  'Je propose ce lot :\n```batch_execute\n{"operations": [{"kind": "move", "refdes": "R1", "x": 1, "y": 2}]}\n```\nÀ toi de valider.';

function fakeComplete(text: string): CompleteFn {
  return vi.fn(async () => ({ text, tokensUsed: 42 }));
}

function makeModel(modelId: string, text: string): TauriMetaModel {
  return new TauriMetaModel({ modelId, complete: fakeComplete(text) });
}

async function readAll(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const reader = stream.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  reader.releaseLock();
  return parts;
}

describe("TauriMetaModel", () => {
  test("texte seul → contenu texte, arrêt stop", async () => {
    const model = makeModel("muse-spark-1.3", TEXT_ONLY);
    const res: LanguageModelV4GenerateResult = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "salut" }] }],
    });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]).toMatchObject({ type: "text", text: TEXT_ONLY });
    expect(res.finishReason.unified).toBe("stop");
  });

  test("bloc lot → tool-call batch_execute + texte narré sans le bloc", async () => {
    const model = makeModel("muse-spark-1.3", WITH_LOT);
    const res: LanguageModelV4GenerateResult = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "déplace R1" }] }],
    });
    const call = res.content.find((c) => c.type === "tool-call");
    expect(call).toMatchObject({ type: "tool-call", toolName: "batch_execute" });
    if (call?.type === "tool-call") {
      expect(JSON.parse(call.input as string)).toEqual({ operations: [{ kind: "move", refdes: "R1", x: 1, y: 2 }] });
    }
    expect(res.finishReason.unified).toBe("tool-calls");
    const text = res.content.find((c) => c.type === "text");
    expect(text).toMatchObject({ type: "text" });
    if (text?.type === "text") expect(text.text).not.toContain("batch_execute");
  });

  test("signal annulé → AbortError (Stop non bloquant)", async () => {
    const model = makeModel("muse-spark-1.3", TEXT_ONLY);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        abortSignal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("outils offerts sans batch_execute → dégradation texte seule", async () => {
    const model = makeModel("autre-modele", WITH_LOT);
    const res: LanguageModelV4GenerateResult = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ type: "function", name: "autre_tool", inputSchema: { type: "object", properties: {} } }],
    });
    expect(res.content.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(res.finishReason.unified).toBe("stop");
  });

  test("doStream émet texte découpé + finish (Stop entre chunks)", async () => {
    const model = makeModel("muse-spark-1.3", "un deux trois");
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    });
    const parts = await readAll(stream);
    const deltas = parts.filter((p) => p.type === "text-delta").map((p) => (p as { delta: string }).delta);
    expect(deltas.join("")).toBe("un deux trois");
    expect(parts.filter((p) => p.type === "finish")).toHaveLength(1);
  });

  test("sérialisation : instructions (system) + tours, jamais de clé", () => {
    const input = serializePrompt(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: [{ type: "text" as const, text: "bonjour" }] },
      ],
      null,
    );
    expect(input.indexOf("SYS")).toBeLessThan(input.indexOf("bonjour"));
    expect(input).not.toMatch(/FAUSSE-CLE/i);
  });

  test("échange simple → Chat Completions, boucle (résultat outil) → Responses", async () => {
    const seen: string[] = [];
    const complete = vi.fn(async (req: { model: string; input: string; maxTokens: number; mode: string }) => {
      seen.push(req.mode);
      return { text: "ok", tokensUsed: 1 };
    });
    const model = new TauriMetaModel({ modelId: "muse-spark-1.3", complete: complete as never });
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "salut" }] }],
    });
    expect(seen).toEqual(["chat"]);
    await model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "déplace R1" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "batch_execute", input: "{}" }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", toolName: "batch_execute", output: { type: "text", value: "lot appliqué" } }],
        },
      ],
    });
    expect(seen).toEqual(["chat", "responses"]);
  });
});
