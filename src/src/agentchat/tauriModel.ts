// Wrapper LanguageModelV4 sur la commande backend T4 (`llm_complete`).
//
// Écart documenté à la stack imposée (justifié, pas de contournement
// possible en T6) : `llm_complete` est un appel texte seul (commande
// dédiée unique, clé du porteur côté backend, `src-tauri` intouchable
// dans ce ticket) — pas de tool-calling natif côté fournisseur. Le
// tool-calling est donc ÉMULÉ au niveau prompt : les instructions
// (`prompt.ts`) décrivent UN bloc ```batch_execute {json} ; ce wrapper
// convertit le bloc en tool-call SDK (schéma Zod validé côté SDK dans
// `tools.ts`). La boucle (`stopWhen`/`ToolLoopAgent`), le streaming
// (`doStream` découpé, `AbortSignal` honoré) et les tests
// (`MockLanguageModelV4`) restent 100 % délégués au SDK.
// Migration native : quand une commande backend exposera les tools,
// seul ce fichier change (le seam `CompleteFn` devient natif).
//
// Règles d'or : aucune clé ici (le `complete` injecté la détient côté
// backend) ; aucun appel sans Projet ouvert (garde dans `session.ts`).

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { BATCH_EXECUTE_TOOL_NAME } from "./schemas";
import { extractBatchFence, hasBatchFence, stripBatchFence } from "./fence";

export interface CompleteReply {
  text: string;
  tokensUsed: number;
}

export interface CompleteRequest {
  model: string;
  input: string;
  maxTokens: number;
}

/** Seam injecté (prod : `llm_complete` via invoke ; tests : double). */
export type CompleteFn = (req: CompleteRequest, signal?: AbortSignal) => Promise<CompleteReply>;

export const COMPLETE_MAX_TOKENS = 2000;

function abortError(): Error {
  const e = new Error("génération interrompue (Stop)");
  e.name = "AbortError";
  return e;
}

function toUsage(tokensUsed: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: tokensUsed, text: tokensUsed, reasoning: undefined },
  };
}

/** Le modèle sait-il recevoir `batch_execute` à ce tour ? */
function batchOffered(options: LanguageModelV4CallOptions): boolean {
  if (!options.tools || options.tools.length === 0) return true;
  return options.tools.some((t) => t.name === BATCH_EXECUTE_TOOL_NAME);
}

function partText(part: { type: string; text?: unknown }): string | null {
  return part.type === "text" && typeof part.text === "string" ? part.text : null;
}

/**
 * Sérialise le prompt SDK en entrée texte unique (commande T4 texte seul).
 * Les instructions arrivent en messages `system` (l'agent y place le
 * cadrage + l'état carte + les résumés de compaction) ; elles ouvrent
 * l'entrée, puis viennent les tours. `tailNote` porte la consigne de
 * protocole du tour (réponse en français, bloc lot ou texte seul).
 */
export function serializePrompt(
  prompt: LanguageModelV4Prompt,
  tailNote: string | null,
): string {
  const systems: string[] = [];
  const turns: string[] = [];
  for (const m of prompt) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) systems.push(m.content);
      continue;
    }
    if (m.role === "user") {
      const texts: string[] = [];
      for (const p of m.content) {
        const t = partText(p as unknown as { type: string; text?: unknown });
        if (t) texts.push(t);
      }
      if (texts.length > 0) turns.push(`[utilisateur] ${texts.join("\n")}`);
      continue;
    }
    if (m.role === "assistant") {
      const texts: string[] = [];
      for (const p of m.content) {
        const pp = p as unknown as { type: string; text?: unknown; toolName?: unknown; input?: unknown };
        const t = partText(pp);
        if (t) texts.push(t);
        else if (pp.type === "tool-call") {
          texts.push(`[appel ${String(pp.toolName)}] ${JSON.stringify(pp.input ?? null)}`);
        }
      }
      if (texts.length > 0) turns.push(`[assistant] ${texts.join("\n")}`);
      continue;
    }
    if (m.role === "tool") {
      const texts: string[] = [];
      for (const p of m.content) {
        const pp = p as unknown as { type: string; output?: unknown; toolName?: unknown };
        if (pp.type === "tool-result") texts.push(`[résultat ${String(pp.toolName)}] ${JSON.stringify(pp.output ?? null)}`);
      }
      if (texts.length > 0) turns.push(texts.join("\n"));
    }
  }
  const parts = [...systems, ...turns];
  if (tailNote) parts.push(tailNote);
  return parts.filter(Boolean).join("\n\n");
}

let callSeq = 0;

/** Modèle Meta via la clé du porteur (commande T4, jamais de clé ici). */
export class TauriMetaModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "meta";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private readonly complete: CompleteFn;
  private readonly maxTokens: number;

  constructor(opts: {
    modelId: string;
    complete: CompleteFn;
    maxTokens?: number;
  }) {
    this.modelId = opts.modelId;
    this.complete = opts.complete;
    this.maxTokens = opts.maxTokens ?? COMPLETE_MAX_TOKENS;
  }

  private buildContent(
    text: string,
    options: LanguageModelV4CallOptions,
  ): { content: LanguageModelV4Content[]; unified: "stop" | "tool-calls" } {
    if (batchOffered(options) && hasBatchFence(text)) {
      const raw = extractBatchFence(text);
      if (raw !== null) {
        const narrated = stripBatchFence(text);
        const content: LanguageModelV4Content[] = [];
        if (narrated) content.push({ type: "text", text: narrated });
        callSeq += 1;
        content.push({
          type: "tool-call",
          toolCallId: `batch-${Date.now().toString(36)}-${callSeq}`,
          toolName: BATCH_EXECUTE_TOOL_NAME,
          // Le SDK valide/reparse lui-même (safeParseJSON) : chaîne brute.
          input: raw,
        });
        return { content, unified: "tool-calls" };
      }
    }
    return { content: [{ type: "text", text: stripBatchFence(text) }], unified: "stop" };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    if (options.abortSignal?.aborted) throw abortError();
    const input = serializePrompt(
      options.prompt,
      "Réponds en français. Pour modifier la carte : UN bloc ```batch_execute {json} ; sinon texte seul.",
    );
    const reply = await this.complete(
      { model: this.modelId, input, maxTokens: this.maxTokens },
      options.abortSignal,
    );
    if (options.abortSignal?.aborted) throw abortError();
    const { content, unified } = this.buildContent(reply.text, options);
    return {
      content,
      finishReason: { unified, raw: unified },
      usage: toUsage(reply.tokensUsed),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    if (options.abortSignal?.aborted) throw abortError();
    const input = serializePrompt(
      options.prompt,
      "Réponds en français. Pour modifier la carte : UN bloc ```batch_execute {json} ; sinon texte seul.",
    );
    const reply = await this.complete(
      { model: this.modelId, input, maxTokens: this.maxTokens },
      options.abortSignal,
    );
    if (options.abortSignal?.aborted) throw abortError();
    const { content, unified } = this.buildContent(reply.text, options);
    const signal = options.abortSignal;
    const textPart = content.find((c) => c.type === "text");
    const toolPart = content.find((c) => c.type === "tool-call");
    const stream = new ReadableStream({
      start(controller) {
        const enqueue = (p: Parameters<typeof controller.enqueue>[0]) => {
          if (signal?.aborted) {
            controller.error(abortError());
            return false;
          }
          controller.enqueue(p);
          return true;
        };
        enqueue({ type: "stream-start", warnings: [] });
        const id = "text-1";
        enqueue({ type: "text-start", id });
        // Streaming simulé par découpe (commande T4 non-SSE) : l'UI reste
        // non bloquante + Stop entre chunks. Le SDK possède la boucle.
        const words = (textPart?.type === "text" ? textPart.text : "").split(/(\s+)/);
        for (const w of words) {
          if (!w) continue;
          if (!enqueue({ type: "text-delta", id, delta: w })) return;
        }
        enqueue({ type: "text-end", id });
        if (toolPart?.type === "tool-call") {
          // Part assemblée (le fournisseur assemble : le cœur attend des
          // parts `tool-call` avec input en chaîne JSON brute).
          enqueue({ type: "tool-call", toolCallId: toolPart.toolCallId, toolName: toolPart.toolName, input: JSON.stringify(toolPart.input) });
        }
        controller.enqueue({ type: "finish", usage: toUsage(reply.tokensUsed), finishReason: { unified, raw: unified } });
        controller.close();
      },
    });
    return { stream };
  }
}
