// S9-A pur — sourcing JLCPCB (frontière module sourcing.ts, fetch injecté).
// Valeurs attendues indépendantes : API jlcsearch documentée via ctx7
// (GET /api/search?q=, GET /api/footprinter_strings/{lcsc}), DSL footprinter
// local @tscircuit/footprinter 0.0.450. Jamais de recalcul par le code.
import { describe, test, expect } from "bun:test";
import { searchParts, generateFootprintDsl, resolveFootprint, parseQueryHints, scorePart, TSCI_SEARCH_DOC, TSCI_IMPORT_DOC } from "../src/sourcing";

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

// Mock par URL exacte (ticket #41) : chaque URL attendue est stubbée
// individuellement — une URL non stubbée (ou un retry silencieux) échoue
// au lieu d'être routée par préfixe. Expose les appels via `calls`.
type ExactRoute = { status: number; body?: unknown; jsonThrows?: boolean } | Error;
function mockFetchExact(routes: Record<string, ExactRoute>) {
  const calls: string[] = [];
  const fn = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const route = routes[u];
    if (route === undefined) throw new Error(`fetch inattendu (URL exacte non stubbée) : ${u}`);
    if (route instanceof Error) throw route;
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => {
        if (route.jsonThrows) throw new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON");
        return route.body;
      },
      text: async () => JSON.stringify(route.body),
    };
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const SEARCH_URL = (q: string) => `https://jlcsearch.tscircuit.com/api/search?q=${encodeURIComponent(q)}`;

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

  test("parseQueryHints 10k 0402 → package + valeur + famille", () => {
    expect(parseQueryHints("10k 0402")).toEqual({ packageHint: "0402", valueToken: "10k", kindHint: "resistor" });
    expect(parseQueryHints("100nF 0603")).toEqual({ packageHint: "0603", valueToken: "100nf", kindHint: "capacitor" });
    expect(parseQueryHints("C21190")).toEqual({ packageHint: null, valueToken: null, kindHint: null });
  });

  test("10k 0402 → le 0402 ranke avant le 0603", async () => {
    const fetchFn = mockFetch({
      "https://jlcsearch.tscircuit.com/api/search": {
        status: 200,
        body: {
          components: [
            { lcsc: 21189, mfr: "0603WAF0000T5E", package: "0603", description: "0Ω 0603 Chip Resistor", stock: 20880653 },
            { lcsc: 25077, mfr: "0402WGF100JTCE", package: "0402", description: "10Ω 0402 Chip Resistor", stock: 3178459 },
          ],
        },
      },
      "https://jlcsearch.tscircuit.com/api/footprinter_strings/": {
        status: 200,
        body: { component_footprinter_details: { lcsc: 0, footprinter_string: null } },
      },
    }) as unknown as typeof fetch;
    const res = await searchParts("10k 0402", { fetchFn, limit: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("attendu ok");
    expect(res.results.length).toBe(2);
    expect(res.results[0]!.package).toBe("0402");
  });

  test("SOT-23 intrus → démote derrière le 0603 pour 100nF 0603", async () => {
    const fetchFn = mockFetch({
      "https://jlcsearch.tscircuit.com/api/search": {
        status: 200,
        body: {
          components: [
            { lcsc: 502564, mfr: "SM712", package: "SOT-23", description: "TVS diode", stock: 136454 },
            { lcsc: 999001, mfr: "C0603C104K8RAC", package: "0603", description: "100nF 0603 MLCC", stock: 5000 },
          ],
        },
      },
      "https://jlcsearch.tscircuit.com/api/footprinter_strings/": {
        status: 200,
        body: { component_footprinter_details: { lcsc: 0, footprinter_string: null } },
      },
    }) as unknown as typeof fetch;
    const res = await searchParts("100nF 0603", { fetchFn, limit: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("attendu ok");
    expect(res.results[0]!.package).toBe("0603");
    expect(res.results[0]!.footprint).toBe("0603");
  });

  test("stock null → enrichi via components/list.json", async () => {
    const fetchFn = mockFetch({
      "https://jlcsearch.tscircuit.com/api/search": {
        status: 200,
        body: {
          components: [
            { lcsc: 21190, mfr: "0603WAF1001T5E", package: "0603", description: "1kΩ 0603", stock: null },
          ],
        },
      },
      "https://jlcsearch.tscircuit.com/components/list.json": {
        status: 200,
        body: { components: [{ lcsc: 21190, stock: 31312558 }] },
      },
      "https://jlcsearch.tscircuit.com/api/footprinter_strings/": {
        status: 200,
        body: { component_footprinter_details: { lcsc: 21190, footprinter_string: null } },
      },
    }) as unknown as typeof fetch;
    const res = await searchParts("C21190", { fetchFn });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("attendu ok");
    expect(res.results[0]!.stock).toBe(31312558);
  });

  test("0 résultat → ok + guidance, rien d'inventé", async () => {
    const fetchFn = mockFetch({
      "https://jlcsearch.tscircuit.com/api/search": { status: 200, body: { components: [] } },
    }) as unknown as typeof fetch;
    const res = await searchParts("RP2040", { fetchFn });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("attendu ok");
    expect(res.results).toEqual([]);
    expect(res.message).toMatch(/aucun résultat/);
  });

  test("doc API exacte tsci présente (search + import --jlcpcb)", () => {
    expect(TSCI_SEARCH_DOC).toMatch(/tsci search --jlcpcb/);
    expect(TSCI_IMPORT_DOC).toMatch(/tsci import.*--jlcpcb/);
  });

  test("HTTP 500 → erreur serveur distinguée, un seul fetch (sans retry)", async () => {
    const fetchFn = mockFetchExact({ [SEARCH_URL("10k")]: { status: 500, body: { error: "boom" } } });
    const res = await searchParts("10k", { fetchFn });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("attendu erreur");
    expect(res.message).toMatch(/HTTP 500/);
    expect(res.message).toMatch(/indisponible|serveur/);
    expect(res.message).toMatch(/réessayez plus tard/);
    expect(fetchFn.calls.length).toBe(1);
  });

  test("HTTP 429 → erreur quota distinguée, un seul fetch (sans retry)", async () => {
    const fetchFn = mockFetchExact({ [SEARCH_URL("10k")]: { status: 429, body: { error: "slow down" } } });
    const res = await searchParts("10k", { fetchFn });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("attendu erreur");
    expect(res.message).toMatch(/HTTP 429/);
    expect(res.message).toMatch(/saturé|quota|rate-limit/);
    expect(res.message).toMatch(/patientez/);
    expect(fetchFn.calls.length).toBe(1);
  });

  test("timeout fetch → erreur timeout distinguée", async () => {
    const timeoutErr = Object.assign(new Error("fetch failed: timeout"), { name: "TimeoutError" });
    const fetchFn = mockFetchExact({ [SEARCH_URL("10k")]: timeoutErr });
    const res = await searchParts("10k", { fetchFn });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("attendu erreur");
    expect(res.message).toMatch(/timeout|interrompue/);
    expect(fetchFn.calls.length).toBe(1);
  });

  test("fetch avorté (AbortError) → erreur timeout distinguée", async () => {
    const fetchFn = mockFetchExact({ [SEARCH_URL("10k")]: new DOMException("This operation was aborted", "AbortError") });
    const res = await searchParts("10k", { fetchFn });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("attendu erreur");
    expect(res.message).toMatch(/timeout|interrompue/);
  });

  test("JSON invalide → erreur JSON distinguée", async () => {
    const fetchFn = mockFetchExact({ [SEARCH_URL("10k")]: { status: 200, jsonThrows: true } });
    const res = await searchParts("10k", { fetchFn });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("attendu erreur");
    expect(res.message).toMatch(/JSON invalide|illisible/);
  });

  test("footprinter_string farfelue → rejetée localement, fallback compilé obligatoire", async () => {
    const fetchFn = mockFetchExact({
      [SEARCH_URL("zzz")]: {
        status: 200,
        body: { components: [{ lcsc: 777001, mfr: "X", package: "zzz-not-a-package", description: "bidule", stock: 5 }] },
      },
      "https://jlcsearch.tscircuit.com/api/footprinter_strings/C777001": {
        status: 200,
        body: { component_footprinter_details: { lcsc: 777001, footprinter_string: "{{{ ceci n'est pas un DSL" } },
      },
    });
    const res = await searchParts("zzz", { fetchFn });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("attendu ok");
    expect(res.results[0]!.footprinterString).toBeNull();
    expect(res.results[0]!.footprintSource).toBe("fallback-package");
    const gen = generateFootprintDsl(res.results[0]!.footprint);
    expect(gen.ok).toBe(true);
  });
});
