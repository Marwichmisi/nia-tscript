// S9-A MCP — outil `search_parts` via vrai client SDK (frontière HTTP MCP).
// fetch global stubbé (jlcsearch) : déterministe, sans réseau.
// Offline strict + query vide : chemins d'erreur déterministes.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests } from "../src/state";
import { ensureTestProject, setupIsolatedRegistry, type IsolatedEnv } from "./helpers";

const TOKEN = "test-search-" + Math.random().toString(36).slice(2);
let PORT = 0;
let server: Server;
let baseUrl = "";
let env: IsolatedEnv;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function connect() {
  const client = new Client({ name: "test-search-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type SearchOutput = {
  sessionId: string;
  query: string;
  source: string;
  tsciSearch: string;
  results: Array<{
    lcsc: string;
    mfr: string;
    package: string;
    description: string;
    stock: number | null;
    footprint: string;
    footprinterString: string | null;
    footprintSource: string;
    tsxSnippet: string;
    tsciImport: string;
  }>;
  banner: string | null;
  message: string | null;
  errors: number;
  warnings: number;
};

const STUB_SEARCH = {
  components: [
    {
      lcsc: 21190,
      mfr: "0603WAF1001T5E",
      package: "0603",
      description: "1kΩ 0603 Chip Resistor",
      stock: 31312558,
    },
  ],
};

const STUB_FP = {
  component_footprinter_details: {
    lcsc: 21190,
    footprinter_string: "res_p1.51mm_pw0.81mm_ph0.86mm_p1.505mm",
    copper_iou: 0.99,
    updated_at: "2026-08-12 05:20:31",
  },
};

function stubFetch(searchBody: unknown = STUB_SEARCH) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.startsWith("https://jlcsearch.tscircuit.com/api/search")) {
      return { ok: true, status: 200, json: async () => searchBody } as Response;
    }
    if (u.startsWith("https://jlcsearch.tscircuit.com/api/footprinter_strings/")) {
      return { ok: true, status: 200, json: async () => STUB_FP } as Response;
    }
    // Transport MCP du test : délègue au vrai fetch.
    return (real as (...args: never[]) => Promise<Response>)(url as never, init as never);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function callSearch(args: Record<string, unknown>): Promise<SearchOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "search_parts", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as SearchOutput;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  env = setupIsolatedRegistry("nia-search-");
  PORT = await freePort();
  server = await startServer({ port: PORT, token: TOKEN });
  baseUrl = `http://127.0.0.1:${PORT}/mcp`;
});

afterAll(() => {
  server.close();
  env.restore();
});

beforeEach(() => {
  resetStoreForTests();
  ensureTestProject();
});

describe("S9-A MCP — search_parts JLCPCB-first", () => {
  test("tools/list expose search_parts (readOnly + openWorld)", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === "search_parts");
      expect(tool).toBeDefined();
      expect(tool!.annotations?.readOnlyHint).toBe(true);
      expect(tool!.annotations?.destructiveHint).toBe(false);
      expect(tool!.annotations?.openWorldHint).toBe(true);
    } finally {
      await transport.close();
    }
  });

  test("C21190 stubbé → LCSC + footprint + snippet + commande tsci", async () => {
    const restore = stubFetch();
    try {
      const out = await callSearch({ query: "C21190" });
      expect(out.errors).toBe(0);
      expect(out.query).toBe("C21190");
      expect(out.source).toBe("jlcpcb");
      expect(out.tsciSearch).toMatch(/tsci search --jlcpcb/);
      expect(out.results.length).toBe(1);
      expect(out.results[0]!.lcsc).toBe("C21190");
      expect(out.results[0]!.mfr).toBe("0603WAF1001T5E");
      expect(out.results[0]!.footprinterString).toBe("res_p1.51mm_pw0.81mm_ph0.86mm_p1.505mm");
      expect(out.results[0]!.tsxSnippet).toMatch(/footprint="/);
      expect(out.results[0]!.tsciImport).toBe('tsci import "C21190" --jlcpcb');
    } finally {
      restore();
    }
  });

  test("0 résultat (ex RP2040) → ok + guidance, rien d'inventé", async () => {
    const restore = stubFetch({ components: [] });
    try {
      const out = await callSearch({ query: "RP2040" });
      expect(out.errors).toBe(0);
      expect(out.results).toEqual([]);
      expect(out.message).toMatch(/aucun résultat/);
    } finally {
      restore();
    }
  });

  test("query vide → erreur exploitable", async () => {
    const out = await callSearch({ query: "   " });
    expect(out.errors).toBe(1);
    expect(out.results).toEqual([]);
    expect(out.message).toMatch(/vide/);
  });

  test("source=mouser → refus explicite (multi-sourcing V2)", async () => {
    const out = await callSearch({ query: "10k", source: "mouser" });
    expect(out.errors).toBe(1);
    expect(out.results).toEqual([]);
    expect(out.message).toMatch(/V2/);
  });

  test("disableCdnLoading → refus offline + bandeau, aucun fetch jlcsearch", async () => {
    const restore = stubFetch();
    let fetched = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).startsWith("https://jlcsearch.tscircuit.com/")) fetched++;
      return (real as (...args: never[]) => Promise<Response>)(url as never, init as never);
    }) as typeof fetch;
    try {
      const out = await callSearch({ query: "10k", disableCdnLoading: true });
      expect(out.errors).toBe(1);
      expect(out.banner).toMatch(/CDN désactivé/);
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = real;
      restore();
    }
  });
});
