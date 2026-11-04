// T2 (I5, #59) — recherche JLC : timeout + progression + erreur explicite.
//
// Seam S5 (`search_parts` cœur + outil) : timeout (défaut 15 s, injectable
// en cœur pour les tests), erreur explicite en cas de timeout, progression
// visible via les logs (début + durée/résultat). Refus offline et V2
// inchangés (suites existantes).
import { describe, test, expect } from "bun:test";
import { searchParts } from "../src/tools-core/sourcing";
import { createMemoryStore } from "../src/tools-core/store";
import { emptyRegistry } from "../src/tools-core/project-core";
import type { ToolsDeps } from "../src/tools-core/deps";
import { runSearchParts } from "../src/tools-core/tools";

/** Fetch qui pend jusqu'à abort (réseau réel bloqué, cas audit 13,6 s). */
function hangingFetch(): typeof fetch {
  return (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    await new Promise<never>((_resolve, reject) => {
      const sig = init?.signal;
      if (sig?.aborted) {
        reject(new DOMException("This operation was aborted", "AbortError"));
        return;
      }
      sig?.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      });
    });
    throw new Error("inatteignable");
  }) as unknown as typeof fetch;
}

function makeDeps(logs: string[], fetchFn: typeof fetch): ToolsDeps {
  const store = createMemoryStore();
  return {
    resolveProject: () => "/projets/demo",
    assertMember: (p) => {
      if (p !== "/projets/demo") throw new Error(`hors périmètre (Confinement) : ${p}`);
      return p;
    },
    boardName: () => "demo",
    compile: (async () => {
      throw new Error("pas de compile dans ce test");
    }) as unknown as ToolsDeps["compile"],
    persist: () => {},
    fetchFn,
    log: (_level, _source, message) => {
      logs.push(message);
    },
    io: {
      canonicalize: (p) => p,
      ensureLayout: () => "exists",
      ensureCircuitFile: () => "exists",
      dirExists: () => true,
      mainExists: () => true,
      readMain: () => "",
      loadRegistry: () => emptyRegistry(),
      saveRegistry: () => {},
      writeLock: () => {},
      listProjects: () => ({ projects: [], lastOpened: null }),
    },
    fab: {
      projectNameForExport: () => "demo",
      resolveExportDir: () => "/tmp/x",
      mkdirp: () => {},
      writeFile: () => {},
      joinPath: (...parts: string[]) => parts.join("/"),
      toFileUrl: (p: string) => `file://${p}`,
    },
    preview: {
      previewDirFor: () => "",
      previewFallbackDir: () => "",
      readPreview: () => ({
        found: false,
        source: "pcb_2d",
        name: null,
        dataUrl: null,
        bytes: 0,
        width: null,
        height: null,
        previewUrl: null,
        updatedAt: null,
        banner: null,
        message: "rien",
        errors: 1,
        warnings: 0,
      }),
    },
    store,
  };
}

describe("T2 I5 — recherche JLC : timeout + progression explicite", () => {
  test("S5 cœur : fetch bloqué → timeout explicite (pas d'outil bloqué)", async () => {
    const t0 = Date.now();
    const res = await searchParts("10k", { fetchFn: hangingFetch(), timeoutMs: 50 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("attendu refus timeout");
    expect(res.message).toMatch(/timeout|interrompue/i);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("S5 outil : progression via logs (début + durée/résultat)", async () => {
    const logs: string[] = [];
    const fetchFn = (async (url: unknown) => {
      const u = String(url);
      await new Promise((r) => setTimeout(r, 20));
      if (u.includes("/api/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            components: [
              {
                lcsc: 21190,
                mfr: "0603WAF1001T5E",
                package: "0603",
                description: "1kΩ 0603 Chip Resistor",
                stock: 100,
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const deps = makeDeps(logs, fetchFn);
    const out = await runSearchParts(deps, { query: "10k" });
    expect(out.output.errors).toBe(0);
    expect(out.output.results.length).toBe(1);
    const all = logs.join("\n");
    expect(all).toMatch(/en cours/);
    expect(all).toMatch(/10k/);
    expect(all).toMatch(/ms/);
  });
});
