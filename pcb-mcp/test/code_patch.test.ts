// S5 — outil MCP code_patch via vrai client SDK (frontière HTTP MCP).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests } from "../src/state";
import { ensureTestProject, setupIsolatedRegistry, type IsolatedEnv } from "./helpers";

const TOKEN = "test-patch-" + Math.random().toString(36).slice(2);
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
  const client = new Client({ name: "test-patch-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type PatchOutput = {
  sessionId: string;
  applied: boolean;
  stats: { total: number; components: number; traces: number; nets: number };
  diagnostics: Array<{ severity: string; message: string; source: string }>;
  mode: string;
  banner: string | null;
  errors: number;
  warnings: number;
  circuitJsonLength: number;
  circuitJson: unknown[];
};

async function callPatch(args: Record<string, unknown>): Promise<PatchOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "code_patch", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as PatchOutput;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  env = setupIsolatedRegistry("nia-patch-");
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
  // Projet explicite (ticket #38) : sans lui, gating = vrai NO_PROJECT_OPEN.
  ensureTestProject();
});

describe("S5 — code_patch diagnostiqué", () => {
  test("tools/list expose code_patch", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("code_patch");
    } finally {
      await transport.close();
    }
  });

  test("patch valide → circuit-json + 0 erreur", async () => {
    const out = await callPatch({
      anchor: `resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`,
      replacement: `resistance="4.7k" footprint="0402" pcbX={-5} pcbY={4}`,
    });
    expect(out.applied).toBe(true);
    expect(out.errors).toBe(0);
    // Warnings embarqués réels (#39) : 7 sur la fixture, sourcés circuit-json.
    expect(out.warnings).toBe(7);
    expect(out.diagnostics).toHaveLength(7);
    expect(out.diagnostics.every((d) => d.source === "circuit-json")).toBe(true);
    expect(out.mode).toBe("worker-blob-local");
    expect(out.banner).toBeNull();
    expect(out.circuitJsonLength).toBeGreaterThan(50);
    expect(out.circuitJson.length).toBe(out.circuitJsonLength);
    expect(out.stats.total).toBe(out.circuitJsonLength);
  }, 60000);

  test("ancre introuvable → rejet exploitable", async () => {
    const out = await callPatch({ anchor: "X-INTROUVABLE-999", replacement: "y" });
    expect(out.applied).toBe(false);
    expect(out.errors).toBe(1);
    expect(out.circuitJson).toEqual([]);
    expect(out.diagnostics[0]!.message).toMatch(/introuvable/);
  });

  test("ancre ambiguë → rejet avec occurrences", async () => {
    const out = await callPatch({ anchor: "<trace", replacement: "<trace" });
    expect(out.applied).toBe(false);
    expect(out.diagnostics[0]!.message).toMatch(/ambiguë/);
  });

  test("patch qui casse le TSX → applied + diagnostics compilateur", async () => {
    const out = await callPatch({
      anchor: `<resistor name="R1"`,
      replacement: `<resistor name="R1" resistance={`,
    });
    expect(out.applied).toBe(true);
    expect(out.errors).toBe(1);
    expect(out.circuitJson).toEqual([]);
    expect(out.diagnostics[0]!.message.length).toBeGreaterThan(10);
  }, 60000);

  test("disableCdnLoading → bandeau offline", async () => {
    const out = await callPatch({
      anchor: `resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`,
      replacement: `resistance="4.7k" footprint="0402" pcbX={-5} pcbY={4}`,
      disableCdnLoading: true,
    });
    expect(out.applied).toBe(true);
    expect(out.errors).toBe(0);
    expect(out.mode).toBe("worker-blob-local-nocdn");
    expect(out.banner).toMatch(/CDN désactivé/);
  }, 60000);

  test("pcb_state + logs_read reflètent le patch (doorbell)", async () => {
    const bad = await callPatch({
      anchor: `<resistor name="R1"`,
      replacement: `<resistor name="R1" resistance={`,
    });
    expect(bad.errors).toBe(1);
    const { client, transport } = await connect();
    try {
      const st = await client.callTool({ name: "pcb_state", arguments: {} });
      const parsed = JSON.parse(
        (st.content as Array<{ text?: string }>)[0]?.text ?? "{}",
      ) as { compile: { status: string; errors: number } };
      expect(parsed.compile.status).toBe("error");
      expect(parsed.compile.errors).toBeGreaterThanOrEqual(1);
      const logs = await client.callTool({ name: "logs_read", arguments: { limit: 100 } });
      const lparsed = JSON.parse(
        (logs.content as Array<{ text?: string }>)[0]?.text ?? "{}",
      ) as { entries: Array<{ message: string; level: string }>; newErrors: number };
      expect(lparsed.newErrors).toBeGreaterThanOrEqual(1);
      expect(lparsed.entries.some((e) => e.message.includes("code_patch"))).toBe(true);
    } finally {
      await transport.close();
    }
  }, 60000);
});
