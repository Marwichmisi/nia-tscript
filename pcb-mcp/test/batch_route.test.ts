// S10-C — batch_execute avec routeur local (ticket #44).
// Contrat : op `route` épingle l'autorouteur local + effort dans le Lot
// atomique ; gate placement exigé (rollback si non vert) ; circuit-json
// routé retourné (preuve rendue par les viewers) ; rollback complet sinon.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests, getCode } from "../src/state";
import { resetQueueForTests } from "../src/queue";

const TOKEN = "test-batch-route-" + Math.random().toString(36).slice(2);
let PORT = 0;
let server: Server;
let baseUrl = "";

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
  const client = new Client({ name: "test-batch-route-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type BatchOutput = {
  sessionId: string;
  applied: boolean;
  ready: boolean;
  failedOpIndex: number | null;
  rolledBack: boolean;
  stats: { total: number; components: number; traces: number; nets: number };
  diagnostics: Array<{ severity: string; message: string; source: string }>;
  mode: string;
  banner: string | null;
  errors: number;
  warnings: number;
  circuitJsonLength: number;
  circuitJson: Array<{ type?: string; route?: unknown[] }>;
  code: string | null;
};

async function callBatch(args: Record<string, unknown>): Promise<BatchOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "batch_execute", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as BatchOutput;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  PORT = await freePort();
  server = await startServer({ port: PORT, token: TOKEN });
  baseUrl = `http://127.0.0.1:${PORT}/mcp`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  resetStoreForTests();
  resetQueueForTests();
});

describe("S10-C — batch_execute avec routeur local", () => {
  test("route seule → applied, autorouter local + effort, circuit-json routé", async () => {
    const out = await callBatch({ operations: [{ kind: "route", effort: "2x" }] });
    expect(out.applied).toBe(true);
    expect(out.errors).toBe(0);
    expect(out.ready).toBe(true);
    expect(out.rolledBack).toBe(false);
    expect(out.code).toContain(`autorouter="auto_local"`);
    expect(out.code).toContain(`autorouterEffortLevel="2x"`);
    // Preuve de routage effectif (rendue par les viewers PCB/schéma/3D).
    const traces = out.circuitJson.filter((e) => e?.type === "pcb_trace");
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.some((t) => Array.isArray(t.route) && t.route.length > 0)).toBe(true);
    expect(getCode()).toContain(`autorouterEffortLevel="2x"`);
  }, 60000);

  test("route + patch qui retire les coords → rollback gate placement, TSX restauré", async () => {
    const before = getCode();
    const out = await callBatch({
      operations: [
        { kind: "route", effort: "2x" },
        {
          kind: "patch",
          anchor: `<resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />`,
          replacement: `<resistor name="R1" resistance="10k" footprint="0402" />`,
        },
      ],
    });
    expect(out.applied).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(out.diagnostics.some((d) => /placement|coords|pcbX/i.test(d.message))).toBe(true);
    expect(getCode()).toBe(before);
  }, 60000);

  test("patch routingDisabled puis route → op route échoue, rollback complet", async () => {
    const before = getCode();
    const out = await callBatch({
      operations: [
        {
          kind: "patch",
          anchor: `<board width="20mm" height="20mm">`,
          replacement: `<board width="20mm" height="20mm" routingDisabled>`,
        },
        { kind: "route", effort: "1x" },
      ],
    });
    expect(out.applied).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(out.failedOpIndex).toBe(1);
    expect(getCode()).toBe(before);
  }, 60000);
});
