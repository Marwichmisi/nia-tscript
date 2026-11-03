// Tests frontière HTTP MCP (#10) — seams S1/S2/S4.
// S1 : tools/call + resources/read via vrai client SDK.
// S2 : guards 403/401/405/400 via requêtes brutes.
// S4 : stdout pure (aucun console.log dans src).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests } from "../src/state";
import { ensureTestProject } from "./helpers";
import type { Server } from "node:http";

const TOKEN = "test-token-" + Math.random().toString(36).slice(2);
let PORT = 0;
let server: Server;
let baseUrl = "";
let tmpRoot = "";
let lockFile = "";
let regFile = "";
let savedLock: string | undefined;
let savedProjectsFile: string | undefined;

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

interface RawOpts {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

function raw(opts: RawOpts): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path: opts.path ?? "/mcp",
        method: opts.method ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string | string[] | undefined>, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function authed(extra: Record<string, string> = {}, body = "") {
  return raw({ headers: { authorization: `Bearer ${TOKEN}`, ...extra }, body });
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nia-server-mcp-"));
  lockFile = path.join(tmpRoot, "mcp.json");
  regFile = path.join(tmpRoot, "projects.json");
  savedLock = process.env.NIATSCIRCUIT_MCP_LOCK;
  savedProjectsFile = process.env.NIATSCIRCUIT_PROJECTS_FILE;
  process.env.NIATSCIRCUIT_MCP_LOCK = lockFile;
  process.env.NIATSCIRCUIT_PROJECTS_FILE = regFile;
  resetStoreForTests();
  // Projet explicite (ticket #38) : S1 teste le vrai chemin "avec projet".
  ensureTestProject("nia-mcp-test-proj");
  PORT = await freePort();
  server = await startServer({ port: PORT, token: TOKEN });
  baseUrl = `http://127.0.0.1:${PORT}/mcp`;
});

afterAll(() => {
  server.close();
  if (savedLock === undefined) delete process.env.NIATSCIRCUIT_MCP_LOCK;
  else process.env.NIATSCIRCUIT_MCP_LOCK = savedLock;
  if (savedProjectsFile === undefined) delete process.env.NIATSCIRCUIT_PROJECTS_FILE;
  else process.env.NIATSCIRCUIT_PROJECTS_FILE = savedProjectsFile;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("S1 — outils et ressources via vrai client MCP", () => {
  async function connect() {
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      // Bearer simple (pas d'OAuth complet au MVP).
      authProvider: { token: async () => TOKEN },
    } as never);
    await client.connect(transport);
    return { client, transport };
  }

  test("tools/list expose pcb_state et logs_read", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain("pcb_state");
      expect(names).toContain("logs_read");
    } finally {
      await transport.close();
    }
  });

  test("tools/call pcb_state répond l'état lecture", async () => {
    const { client, transport } = await connect();
    try {
      const res = await client.callTool({ name: "pcb_state", arguments: {} });
      const text = (res.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed.board).toBe("nia-mcp-test-proj");
      expect(parsed.ready).toBe(true);
      expect(parsed.protocolVersion).toBe("2026-07-28");
      expect((res as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
        board: "nia-mcp-test-proj",
        ready: true,
      });
    } finally {
      await transport.close();
    }
  });

  test("tools/call logs_read pagine avec curseur et signale les erreurs", async () => {
    const { client, transport } = await connect();
    try {
      const res = await client.callTool({ name: "logs_read", arguments: { limit: 2 } });
      const text = (res.content as Array<{ type: string; text?: string }>)[0]!.text!;
      const parsed = JSON.parse(text);
      expect(parsed.entries).toHaveLength(2);
      expect(typeof parsed.nextCursor).toBe("string");
      expect(typeof parsed.hasMore).toBe("boolean");
      expect(typeof parsed.newErrors).toBe("number");
      const res2 = await client.callTool({
        name: "logs_read",
        arguments: { cursor: parsed.nextCursor, limit: 20 },
      });
      const text2 = (res2.content as Array<{ type: string; text?: string }>)[0]!.text!;
      const parsed2 = JSON.parse(text2);
      expect(parsed2.entries[0]?.seq).toBeGreaterThan(Number(parsed.nextCursor) || 0);
    } finally {
      await transport.close();
    }
  });

  test("resources/list + resources/read pcb://hierarchy", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listResources();
      const uris = list.resources.map((r) => r.uri);
      expect(uris).toContain("pcb://hierarchy");
      const read = await client.readResource({ uri: "pcb://hierarchy" });
      const text = (read.contents[0] as { text?: string })?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed.board).toBe("nia-mcp-test-proj");
      expect(parsed.modules[0].components.map((c: { refdes: string }) => c.refdes)).toContain("R1");
    } finally {
      await transport.close();
    }
  });

  test("fallback legacy initialize répond via HTTP", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "0.0.0" },
      },
    });
    const r = await authed({}, body);
    expect(r.status).toBe(200);
    expect(r.body).toContain("jsonrpc");
  });
});

describe("S2 — guards HTTP", () => {
  const goodBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  const goodHeaders = {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/list",
  };

  test("Origin invalide → 403", async () => {
    const r = await authed({ ...goodHeaders, origin: "https://evil.test" }, goodBody);
    expect(r.status).toBe(403);
  });

  test("Host non-localhost → 403", async () => {
    const r = await raw({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        host: "evil.test",
        ...goodHeaders,
      },
      body: goodBody,
    });
    expect(r.status).toBe(403);
  });

  test("sans bearer → 401 (+ WWW-Authenticate), mauvais bearer → 401", async () => {
    const sans = await raw({ headers: { ...goodHeaders }, body: goodBody });
    expect(sans.status).toBe(401);
    expect(String(sans.headers["www-authenticate"] ?? "")).toContain("Bearer");
    const mauvais = await raw({
      headers: { authorization: "Bearer mauvais-token", ...goodHeaders },
      body: goodBody,
    });
    expect(mauvais.status).toBe(401);
  });

  test("GET/DELETE → 405", async () => {
    const get = await raw({ method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    const del = await raw({ method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(del.status).toBe(405);
  });

  test("version inconnue → 400", async () => {
    const r = await authed(
      { "mcp-protocol-version": "2099-99-99", "mcp-method": "tools/list" },
      goodBody,
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/-3202\d/);
  });

  test("mismatch header/body → 400 rejeté", async () => {
    const mismatchBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "1999-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const r = await authed({ ...goodHeaders }, mismatchBody);
    expect(r.status).toBe(400);
  });

  test("méthode inconnue → 404 + -32601", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/bogus",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const r = await authed({ "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/bogus" }, body);
    expect(r.status).toBe(404);
    expect(r.body).toContain("-32601");
  });
});

describe("S4 — logs jamais sur stdout", () => {
  test("aucun console.log dans pcb-mcp/src", () => {
    const srcDir = path.join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".ts")) continue;
      const text = fs.readFileSync(path.join(srcDir, f), "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (/(^|[^a-zA-Z])console\.log\b/.test(line)) offenders.push(`${f}:${i + 1}:${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
