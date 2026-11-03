// S-preview-MCP — outil preview_screenshot via vrai client SDK (frontière HTTP MCP).
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
import { savePreview } from "../src/preview";
import { currentProjectPath, projectPreviewsDir } from "../src/project";

const TOKEN = "test-preview-" + Math.random().toString(36).slice(2);
let PORT = 0;
let server: Server;
let baseUrl = "";
let previewDir = "";

const PIXEL_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  const client = new Client({ name: "test-preview-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type PreviewOutput = {
  sessionId: string;
  source: string;
  found: boolean;
  dataUrl: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  previewUrl: string | null;
  banner: string | null;
  message: string | null;
  errors: number;
  warnings: number;
};

async function callPreview(args: Record<string, unknown>): Promise<PreviewOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "preview_screenshot", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as PreviewOutput;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  previewDir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-preview-mcp-"));
  process.env.PCB_MCP_PREVIEW_DIR = previewDir;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nia-preview-lock-"));
  process.env.NIATSCIRCUIT_MCP_LOCK = path.join(tmpRoot, "mcp.json");
  process.env.NIATSCIRCUIT_PROJECTS_FILE = path.join(tmpRoot, "projects.json");
  (globalThis as Record<string, string>).__niaPreviewTmpRoot = tmpRoot;
  PORT = await freePort();
  server = await startServer({ port: PORT, token: TOKEN });
  baseUrl = `http://127.0.0.1:${PORT}/mcp`;
});

afterAll(() => {
  server.close();
  delete process.env.PCB_MCP_PREVIEW_DIR;
  delete process.env.NIATSCIRCUIT_MCP_LOCK;
  delete process.env.NIATSCIRCUIT_PROJECTS_FILE;
  const tmpRoot = (globalThis as Record<string, string>).__niaPreviewTmpRoot;
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetStoreForTests();
  for (const f of fs.readdirSync(previewDir)) fs.rmSync(path.join(previewDir, f), { force: true });
  // Vide aussi <Projet test>/previews/ pour que le fallback override soit déterministe.
  try {
    const proj = currentProjectPath();
    if (proj) {
      const d = projectPreviewsDir(proj);
      if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true });
    }
  } catch { /* best-effort */ }
});

describe("S-preview-MCP — preview_screenshot agent", () => {
  test("tools/list expose preview_screenshot", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("preview_screenshot");
    } finally {
      await transport.close();
    }
  });

  test("sans screenshot → explicite, jamais d'image inventée", async () => {
    const out = await callPreview({ source: "pcb_2d" });
    expect(out.found).toBe(false);
    expect(out.dataUrl).toBeNull();
    expect(out.previewUrl).toBeNull();
    expect(out.errors).toBe(1);
    expect(`${out.message ?? ""}`).toMatch(/ouvre l'app/);
  });

  test("screenshot déposé → base64 + taille + lien preview locale", async () => {
    savePreview({ source: "schematic_2d", dataUrl: PIXEL_1X1, width: 1238, height: 612 }, previewDir);
    const out = await callPreview({ source: "schematic_2d" });
    expect(out.found).toBe(true);
    expect(out.errors).toBe(0);
    expect(out.dataUrl).toBe(PIXEL_1X1);
    expect(out.bytes).toBeGreaterThan(50);
    expect(out.width).toBe(1238);
    expect(out.height).toBe(612);
    expect(out.previewUrl?.startsWith("file://")).toBe(true);
    expect(out.banner).toBeNull();
  });

  test("alias prototype schematique_2d → source canonique", async () => {
    savePreview({ source: "schematic_2d", dataUrl: PIXEL_1X1, width: 10, height: 10 }, previewDir);
    const out = await callPreview({ source: "schematique_2d" });
    expect(out.found).toBe(true);
    expect(out.source).toBe("schematic_2d");
  });

  test("source inconnue → erreur exploitable", async () => {
    const out = await callPreview({ source: "gerber_layer" });
    expect(out.found).toBe(false);
    expect(out.errors).toBe(1);
    expect(`${out.message ?? ""}`).toMatch(/schematic_2d/);
  });

  test("mode offline strict → bandeau explicite", async () => {
    savePreview({ source: "pcb_3d", dataUrl: PIXEL_1X1, width: 5, height: 5 }, previewDir);
    const out = await callPreview({ source: "pcb_3d", disableCdnLoading: true });
    expect(out.found).toBe(true);
    expect(out.banner).toMatch(/CDN|RÉSEAU/);
  });
});
