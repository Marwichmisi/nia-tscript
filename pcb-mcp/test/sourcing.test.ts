// S9-A pur — sourcing JLCPCB (frontière module sourcing.ts, fetch injecté).
// Valeurs attendues indépendantes : API jlcsearch documentée via ctx7
// (GET /api/search?q=, GET /api/footprinter_strings/{lcsc}), DSL footprinter
// local @tscircuit/footprinter 0.0.450. Jamais de recalcul par le code.
import { describe, test, expect } from "bun:test";
import { searchParts, generateFootprintDsl, resolveFootprint, TSCI_SEARCH_DOC, TSCI_IMPORT_DOC } from "../src/sourcing";

function mockFetch(routes: Record<string, { status: number; body: unknown }>) {
  return async (url: unknown) => {
    const u = String(url);
    for (const [prefix, res] of Object.entries(routes)) {
      if (u.startsWith(prefix)) {
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: async () => res.body,
          text: async () => JSON.stringify(res.body),
        };
      }
    }
    throw new Error(`fetch inattendu : ${u}`);
  };
}

describe("S9-A — sourcing.searchParts pur", () => {
  test("query vide → erreur exploitable, aucun fetch", async () => {
    let called = 0;
    const res = await searchParts("   ", {
      fetchFn: (async () => {
        called++;
        throw new Error("ne doit pas fetcher");
      }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/vide/);
    expect(called).toBe(0);
  });

  test("disableCdnLoading → refus réseau explicite, aucun fetch", async () => {
    let called = 0;
    const res = await searchParts("10k", {
      disableCdnLoading: true,
      fetchFn: (async () => {
        called++;
        throw new Error("ne doit pas fetcher");
      }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/hors-ligne|CDN désactivé/);
    expect(called).toBe(0);
  });

  test("C21190 → LCSC + footprint footprinter + snippet + commande tsci", async () => {
    const fetchFn = mockFetch({
      "https://jlcsearch.tscircuit.com/api/search": {
        status: 200,
        body: {
          components: [
            {
              lcsc: 21190,
              mfr: "0603WAF1001T5E",
              package: "0603",
              description: "1kΩ 0603 Chip Resistor",
              stock: 31312558,
              price: 0.0017,
            },
          ],
        },
      },
      "https://jlcsearch.tscircuit.com/api/footprinter_strings/": {
        status: 200,
        body: {
          component_footprinter_details: {
            lcsc: 21190,
            footprinter_string: "res_p1.51mm_pw0.81mm_ph0.86mm_p1.505mm",
            copper_iou: 0.99,
            updated_at: "2026-08-12 05:20:31",
          },
        },
      },
    }) as unknown as typeof fetch;
    const res = await searchParts("C21190", { fetchFn, limit: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("attendu ok");
    expect(res.results.length).toBe(1);
    expect(res.results[0]!.lcsc).toBe("C21190");
    expect(res.results[0]!.mfr).toBe("0603WAF1001T5E");
    expect(res.results[0]!.footprinterString).toBe("res_p1.51mm_pw0.81mm_ph0.86mm_p1.505mm");
    expect(res.results[0]!.footprint.length).toBeGreaterThan(2);
    expect(res.results[0]!.tsxSnippet).toMatch(/footprint="/);
    expect(res.results[0]!.tsciImport).toBe('tsci import "C21190" --jlcpcb');
  });

  test("footprinter_string null → fallback package validé localement", async () => {
    const fetchFn = mockFetch({
      "https://jlcsearch.tscircuit.com/api/search": {
        status: 200,
        body: {
          components: [
            { lcsc: 12345, mfr: "X-1", package: "0402", description: "Resistor", stock: 10 },
          ],
        },
      },
      "https://jlcsearch.tscircuit.com/api/footprinter_strings/": {
        status: 200,
        body: { component_footprinter_details: { lcsc: 12345, footprinter_string: null } },
      },
    }) as unknown as typeof fetch;
    const res = await searchParts("0402 resistor", { fetchFn });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("attendu ok");
    expect(res.results[0]!.footprint).toBe("0402");
    expect(res.results[0]!.footprintSource).toBe("fallback-package");
  });

  test("generateFootprintDsl 0402 → DSL compilé (pads > 0)", async () => {
    const out = generateFootprintDsl("0402");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("attendu ok");
    expect(out.footprint).toBe("0402");
    expect(out.padCount).toBeGreaterThanOrEqual(2);
  });

  test("generateFootprintDsl vide → erreur exploitable", () => {
    const out = generateFootprintDsl("   ");
    expect(out.ok).toBe(false);
  });

  test("package inconnu → DSL 0402 généré et compilé (fallback-package)", () => {
    const out = resolveFootprint("zzz-not-a-package", null);
    expect(out.footprint).toBe("0402");
    expect(out.footprintSource).toBe("fallback-package");
    const gen = generateFootprintDsl(out.footprint);
    expect(gen.ok).toBe(true);
  });

  test("doc API exacte tsci présente (search + import --jlcpcb)", () => {
    expect(TSCI_SEARCH_DOC).toMatch(/tsci search --jlcpcb/);
    expect(TSCI_IMPORT_DOC).toMatch(/tsci import.*--jlcpcb/);
  });
});
