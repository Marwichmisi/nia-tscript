// S10-B — outil MCP batch_execute via vrai client SDK (frontière HTTP MCP).
// Contrat ticket #16 : lot atomique patch+live, rollback complet, une seule
// approbation (un seul tools/call), hints corrects, readiness stampée.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests, getCode } from "../src/state";
import { resetQueueForTests } from "../src/queue";

const TOKEN = "test-batch-" + Math.random().toString(36).slice(2);
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
  const client = new Client({ name: "test-batch-client", version: "0.1.0" });
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
  circuitJson: unknown[];
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

describe("S10-B — batch_execute atomique", () => {
  test("tools/list expose batch_execute avec hints destructifs", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === "batch_execute");
      expect(tool).toBeDefined();
      expect(tool!.annotations?.readOnlyHint).toBe(false);
      expect(tool!.annotations?.destructiveHint).toBe(true);
    } finally {
      await transport.close();
    }
  });

  test("lot mixte valide patch + move → applied, TSX combiné, ready", async () => {
    const out = await callBatch({
      operations: [
        {
          kind: "patch",
          anchor: `resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`,
          replacement: `resistance="4.7k" footprint="0402" pcbX={-5} pcbY={4}`,
        },
        { kind: "move", refdes: "R1", x: 3, y: -2 },
      ],
    });
    expect(out.applied).toBe(true);
    expect(out.errors).toBe(0);
    expect(out.ready).toBe(true);
    expect(out.rolledBack).toBe(false);
    expect(out.code).toContain(`resistance="4.7k"`);
    expect(out.code).toContain(`pcbX={3}`);
    expect(getCode()).toContain(`resistance="4.7k"`);
  }, 60000);

  test("lot mixte qui échoue → rollback complet, état inchangé", async () => {
    const before = getCode();
    const out = await callBatch({
      operations: [
        {
          kind: "patch",
          anchor: `resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`,
          replacement: `resistance="4.7k" footprint="0402" pcbX={-5} pcbY={4}`,
        },
        { kind: "move", refdes: "R9", x: 1, y: 1 },
      ],
    });
    expect(out.applied).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(out.failedOpIndex).toBe(1);
    expect(getCode()).toBe(before);
    // pcb_state inchangé (compile restée ok, ready true)
    const { client, transport } = await connect();
    try {
      const st = await client.callTool({ name: "pcb_state", arguments: {} });
      const parsed = JSON.parse((st.content as Array<{ text?: string }>)[0]?.text ?? "{}");
      expect(parsed.ready).toBe(true);
      expect(parsed.compile.status).toBe("ok");
    } finally {
      await transport.close();
    }
  }, 60000);

  test("patch qui casse la compile → rollback, TSX restauré", async () => {
    const before = getCode();
    const out = await callBatch({
      operations: [{ kind: "patch", anchor: `<resistor name="R1"`, replacement: `<resistor name="R1" resistance={` }],
    });
    expect(out.applied).toBe(false);
    expect(out.rolledBack).toBe(true);
    expect(getCode()).toBe(before);
  }, 60000);

  test("lot vide → rejet sans écrire", async () => {
    const before = getCode();
    const out = await callBatch({ operations: [] });
    expect(out.applied).toBe(false);
    expect(getCode()).toBe(before);
  });
});
