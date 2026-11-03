// S8-B — outil MCP live_manage via vrai client SDK (frontière HTTP MCP).
// Contrat ticket #14 : move/rotate/swap_package/reassign_net + select/view,
// write-through TSX + recompile verte + readiness, création refusée vers
// code_patch, mutations concurrentes sérialisées par la file.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests, getCode } from "../src/state";
import { resetQueueForTests } from "../src/queue";
import { ensureTestProject, setupIsolatedRegistry, type IsolatedEnv } from "./helpers";

const TOKEN = "test-live-" + Math.random().toString(36).slice(2);
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
  const client = new Client({ name: "test-live-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type LiveOutput = {
  sessionId: string;
  op: string;
  applied: boolean;
  ready: boolean;
  stats: { total: number; components: number; traces: number; nets: number };
  diagnostics: Array<{ severity: string; message: string; source: string }>;
  mode: string;
  banner: string | null;
  errors: number;
  warnings: number;
  circuitJsonLength: number;
  circuitJson: unknown[];
  code: string | null;
  selection: { refdes: string; pkg: string; value: string; rotation: number; nets: string[] } | null;
  views: string[] | null;
  message: string | null;
};

async function callLive(args: Record<string, unknown>): Promise<LiveOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "live_manage", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as LiveOutput;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  env = setupIsolatedRegistry("nia-live-");
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
  resetQueueForTests();
  ensureTestProject();
});

describe("S8-B — live_manage write-through", () => {
  test("tools/list expose live_manage", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("live_manage");
    } finally {
      await transport.close();
    }
  });

  test("move R1 → TSX réécrit + recompile verte + readiness true", async () => {
    const out = await callLive({ op: "move", refdes: "R1", x: 3, y: -2 });
    expect(out.applied).toBe(true);
    expect(out.errors).toBe(0);
    expect(out.ready).toBe(true);
    expect(out.op).toBe("move");
    expect(out.code).toContain("pcbX={3}");
    expect(out.code).toContain("pcbY={-2}");
    expect(getCode()).toContain("pcbX={3}");
    expect(out.stats.total).toBeGreaterThan(50);
    expect(out.circuitJsonLength).toBeGreaterThan(50);
    // pcb_state reflète readiness
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

  test("rotate + swap_package + reassign_net → verts", async () => {
    const r = await callLive({ op: "rotate", refdes: "U1", degrees: 90 });
    expect(r.applied).toBe(true);
    expect(r.errors).toBe(0);
    expect(r.ready).toBe(true);
    const s = await callLive({ op: "swap_package", refdes: "R1", footprint: "0603" });
    expect(s.applied).toBe(true);
    expect(s.errors).toBe(0);
    const n = await callLive({ op: "reassign_net", refdes: "R1", pin: "pin1", net: "GND" });
    expect(n.applied).toBe(true);
    expect(n.errors).toBe(0);
    expect(n.ready).toBe(true);
    expect(n.code).toContain("net.GND");
  }, 120000);

  test("select + view → lecture sans écriture, readiness stampée", async () => {
    const sel = await callLive({ op: "select", refdes: "R1" });
    expect(sel.applied).toBe(true);
    expect(sel.ready).toBe(true);
    expect(sel.selection?.refdes).toBe("R1");
    const before = getCode();
    const view = await callLive({ op: "view" });
    expect(view.applied).toBe(true);
    expect(view.ready).toBe(true);
    expect(view.views).toContain("pcb");
    expect(getCode()).toBe(before);
  }, 60000);

  test("création live → erreur explicite vers code_patch, TSX inchangé", async () => {
    const before = getCode();
    const out = await callLive({ op: "create", refdes: "R3" });
    expect(out.applied).toBe(false);
    expect(out.errors).toBe(1);
    expect(`${out.message ?? ""} ${out.diagnostics[0]?.message ?? ""}`).toMatch(/code_patch/);
    expect(getCode()).toBe(before);
  });

  test("suppression live → refusée vers code_patch", async () => {
    const before = getCode();
    const out = await callLive({ op: "delete", refdes: "R1" });
    expect(out.applied).toBe(false);
    expect(out.errors).toBe(1);
    expect(`${out.message ?? ""} ${out.diagnostics[0]?.message ?? ""}`).toMatch(/code_patch/);
    expect(getCode()).toBe(before);
  });

  test("deux moves concurrents → sérialisés, état final cohérent", async () => {
    const [a, b] = await Promise.all([
      callLive({ op: "move", refdes: "R1", x: 1, y: 1 }),
      callLive({ op: "move", refdes: "R1", x: 2, y: 2 }),
    ]);
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    const code = getCode();
    // L'état final correspond à l'une des deux mutations drainées (pas de mélange).
    const isA = code.includes("pcbX={1}") && code.includes("pcbY={1}");
    const isB = code.includes("pcbX={2}") && code.includes("pcbY={2}");
    expect(isA !== isB).toBe(true);
    // pcb_state cohérent avec le TSX final
    const { client, transport } = await connect();
    try {
      const st = await client.callTool({ name: "pcb_state", arguments: {} });
      const parsed = JSON.parse((st.content as Array<{ text?: string }>)[0]?.text ?? "{}");
      expect(parsed.ready).toBe(true);
      expect(parsed.compile.status).toBe("ok");
    } finally {
      await transport.close();
    }
  }, 120000);
});
