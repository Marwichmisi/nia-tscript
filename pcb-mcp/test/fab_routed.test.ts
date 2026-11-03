// S9-C MCP — fab_export sur board routé et vérifié (ticket #44).
// Contrat : l'export de fabrication sort d'un board routé (autorouteur
// local) et vérifié (gate DRC #39) ; un board déclaré routingDisabled ou
// sans trace routée est refusé explicitement, aucun fichier inventé.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests } from "../src/state";
import { resetQueueForTests } from "../src/queue";
import { ensureTestProject, setupIsolatedRegistry, type IsolatedEnv } from "./helpers";

const TOKEN = "test-fab-routed-" + Math.random().toString(36).slice(2);
let PORT = 0;
let server: Server;
let baseUrl = "";
let exportDir = "";
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
  const client = new Client({ name: "test-fab-routed-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type FabOutput = {
  ready: boolean;
  mode: string;
  errors: number;
  counts: { gerberFiles: number; bomRows: number; pnpRows: number };
  exportDir: string;
  artifacts: Array<{ name: string; bytes: number; previewUrl: string }>;
  message: string | null;
};

async function callFab(args: Record<string, unknown>): Promise<FabOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "fab_export", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as FabOutput;
  } finally {
    await transport.close();
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { client, transport } = await connect();
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  env = setupIsolatedRegistry("nia-fab-routed-reg-");
  PORT = await freePort();
  server = await startServer({ port: PORT, token: TOKEN });
  baseUrl = `http://127.0.0.1:${PORT}/mcp`;
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-fab-routed-test-"));
  process.env.PCB_MCP_EXPORT_DIR = exportDir;
});

afterAll(() => {
  server.close();
  env.restore();
  delete process.env.PCB_MCP_EXPORT_DIR;
  fs.rmSync(exportDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetStoreForTests();
  resetQueueForTests();
  // Projet explicite (#38) : sans lui, gating = vrai NO_PROJECT_OPEN.
  ensureTestProject();
});

describe("S9-C MCP — fab_export board routé et vérifié", () => {
  test("board routé via Lot (route 2x) → fab_export ok, gerbers avec cuivre", async () => {
    await callTool("batch_execute", { operations: [{ kind: "route", effort: "2x" }] });
    const out = await callFab({});
    expect(out.errors).toBe(0);
    expect(out.ready).toBe(true);
    expect(out.counts.gerberFiles).toBeGreaterThan(0);
    const fcu = fs.readFileSync(path.join(out.exportDir, "gerbers", "F_Cu.gbr"), "utf8");
    expect(fcu.length).toBeGreaterThan(0);
  }, 120000);

  test("board routingDisabled → fab_export refusé, aucun fichier", async () => {
    await callTool("code_patch", {
      anchor: `<board width="20mm" height="20mm">`,
      replacement: `<board width="20mm" height="20mm" routingDisabled>`,
    });
    const out = await callFab({});
    expect(out.ready).toBe(false);
    expect(out.errors).toBeGreaterThanOrEqual(1);
    expect(out.message).toMatch(/non routé|routingDisabled/);
    expect(out.exportDir).toBe("");
    expect(out.artifacts).toEqual([]);
  }, 120000);
});
