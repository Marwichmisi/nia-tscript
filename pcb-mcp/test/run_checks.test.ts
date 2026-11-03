// S7-B — outil MCP run_checks via vrai client SDK (frontière HTTP MCP).
// Contrat ticket #13 : checks natifs netlist/placement/routing/style +
// violations positionnées, gate dur (routing refusé si placement non vert),
// fixture invalide en preuve.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests } from "../src/state";
import { ensureTestProject, setupIsolatedRegistry, type IsolatedEnv } from "./helpers";

const TOKEN = "test-checks-" + Math.random().toString(36).slice(2);
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
  const client = new Client({ name: "test-checks-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type ChecksOutput = {
  sessionId: string;
  domain: string;
  placementGreen: boolean;
  routingAllowed: boolean;
  blockReason: string | null;
  counts: { netlist: number; placement: number; routing: number; style: number; total: number };
  violations: Array<{
    domain: string;
    type: string;
    message: string;
    x: number | null;
    y: number | null;
    refdes: string | null;
  }>;
  errors: number;
  warnings: number;
};

async function callChecks(args: Record<string, unknown>): Promise<ChecksOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "run_checks", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as ChecksOutput;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  env = setupIsolatedRegistry("nia-checks-");
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

describe("S7-B — run_checks + gate placement", () => {
  test("tools/list expose run_checks", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("run_checks");
    } finally {
      await transport.close();
    }
  });

  test("fixture valide → placement vert, routing autorisé, 0 violation", async () => {
    const out = await callChecks({ domain: "all" });
    expect(out.placementGreen).toBe(true);
    expect(out.routingAllowed).toBe(true);
    expect(out.blockReason).toBeNull();
    expect(out.counts.total).toBe(0);
    expect(out.violations).toEqual([]);
    expect(out.errors).toBe(0);
  }, 90000);

  test("board valide → routing autorisé (domain routing)", async () => {
    const out = await callChecks({ domain: "routing" });
    expect(out.placementGreen).toBe(true);
    expect(out.routingAllowed).toBe(true);
    expect(out.blockReason).toBeNull();
    expect(out.errors).toBe(0);
  }, 90000);

  test("fixture overlap → placement liste violations positionnées", async () => {
    const { client, transport } = await connect();
    try {
      await client.callTool({
        name: "code_patch",
        arguments: {
          anchor: `<resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={-4} />`,
          replacement: `<resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />`,
        },
      });
    } finally {
      await transport.close();
    }
    const out = await callChecks({ domain: "placement" });
    expect(out.placementGreen).toBe(false);
    expect(out.routingAllowed).toBe(false);
    expect(out.counts.placement).toBeGreaterThanOrEqual(1);
    expect(out.violations.length).toBeGreaterThanOrEqual(1);
    expect(out.violations[0]!.message.length).toBeGreaterThan(10);
    const positioned = out.violations.filter((v) => typeof v.x === "number" && typeof v.y === "number");
    expect(positioned.length).toBeGreaterThanOrEqual(1);
  }, 120000);

  test("placement invalide → routing refusé avec erreur explicite", async () => {
    const { client, transport } = await connect();
    try {
      await client.callTool({
        name: "code_patch",
        arguments: {
          anchor: `<resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={-4} />`,
          replacement: `<resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />`,
        },
      });
    } finally {
      await transport.close();
    }
    const out = await callChecks({ domain: "routing" });
    expect(out.routingAllowed).toBe(false);
    expect(out.errors).toBe(1);
    expect(out.blockReason).toMatch(/placement non vert/);
  }, 120000);
});
