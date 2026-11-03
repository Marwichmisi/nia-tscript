// S9-B MCP — outil `fab_export` via vrai client SDK (frontière HTTP MCP).
// Fixture R1/R2+U1 → fichiers écrits dans PCB_MCP_EXPORT_DIR (tmp test),
// relus depuis le disque : gerbers RS-274X, BOM/PnP CSV, KiCad, zips
// ouvrables. Chemin d'erreur : TSX cassé → aucun fichier inventé.
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

const TOKEN = "test-fab-" + Math.random().toString(36).slice(2);
let PORT = 0;
let server: Server;
let baseUrl = "";
let exportDir = "";

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
  const client = new Client({ name: "test-fab-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type FabOutput = {
  sessionId: string;
  ready: boolean;
  mode: string;
  banner: string | null;
  errors: number;
  warnings: number;
  counts: { gerberFiles: number; bomRows: number; pnpRows: number };
  gerberNames: string[];
  gerberPreview: string;
  bomCsv: string;
  pnpCsv: string;
  kicad: { pcbBytes: number; schBytes: number; proBytes: number; pcbPreview: string };
  kicadZip: { bytes: number; previewUrl: string };
  fabZip: { bytes: number; previewUrl: string };
  artifacts: Array<{ name: string; bytes: number; previewUrl: string }>;
  exportDir: string;
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

beforeAll(async () => {
  PORT = await freePort();
  server = await startServer({ port: PORT, token: TOKEN });
  baseUrl = `http://127.0.0.1:${PORT}/mcp`;
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-fab-test-"));
  process.env.PCB_MCP_EXPORT_DIR = exportDir;
});

afterAll(() => {
  server.close();
  delete process.env.PCB_MCP_EXPORT_DIR;
  fs.rmSync(exportDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetStoreForTests();
});

describe("S9-B MCP — fab_export V1", () => {
  test("tools/list expose fab_export", async () => {
    const { client, transport } = await connect();
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === "fab_export");
      expect(tool).toBeDefined();
      expect(tool!.annotations?.destructiveHint).toBe(false);
    } finally {
      await transport.close();
    }
  });

  test("fixture → artefacts écrits et ouvrables (gerbers, BOM, PnP, KiCad, zips)", async () => {
    const out = await callFab({});
    expect(out.errors).toBe(0);
    expect(out.ready).toBe(true);
    expect(out.counts.gerberFiles).toBe(10);
    expect(out.counts.bomRows).toBe(3);
    expect(out.counts.pnpRows).toBe(3);
    expect(out.exportDir.startsWith(exportDir)).toBe(true);
    // Fichiers relus depuis le disque (jamais d'inventé).
    const fcu = fs.readFileSync(path.join(out.exportDir, "gerbers", "F_Cu.gbr"), "utf8");
    expect(fcu).toMatch(/%TF\.|%FS/);
    const bom = fs.readFileSync(path.join(out.exportDir, "bom.csv"), "utf8");
    expect(bom).toMatch(/R1/);
    expect(bom).toMatch(/U1/);
    const pnp = fs.readFileSync(path.join(out.exportDir, "pick-and-place.csv"), "utf8");
    expect(pnp).toMatch(/R1/);
    const pcbFiles = fs.readdirSync(out.exportDir).filter((f) => f.endsWith(".kicad_pcb"));
    expect(pcbFiles.length).toBe(1);
    const pcb = fs.readFileSync(path.join(out.exportDir, pcbFiles[0]!), "utf8");
    expect(pcb).toMatch(/\(kicad_pcb/);
    const schFiles = fs.readdirSync(out.exportDir).filter((f) => f.endsWith(".kicad_sch"));
    expect(schFiles.length).toBe(1);
    const sch = fs.readFileSync(path.join(out.exportDir, schFiles[0]!), "utf8");
    expect(sch).toMatch(/\(kicad_sch/);
    // Zips ouvrables.
    const JSZip = (await import("jszip")).default;
    const kicadZip = await JSZip.loadAsync(fs.readFileSync(path.join(out.exportDir, "kicad_project.zip")));
    expect(Object.keys(kicadZip.files).join(",")).toMatch(/kicad_pcb/);
    const fabZip = await JSZip.loadAsync(fs.readFileSync(path.join(out.exportDir, "fab_upload.zip")));
    const names = Object.keys(fabZip.files).join(",");
    expect(names).toMatch(/F_Cu\.gbr/);
    expect(names).toMatch(/bom\.csv/);
    expect(names).toMatch(/pick-and-place\.csv/);
    expect(out.kicadZip.previewUrl).toMatch(/^file:\/\//);
    expect(out.fabZip.previewUrl).toMatch(/^file:\/\//);
  }, 90000);

  test("TSX cassé → erreur exploitable, aucun export", async () => {
    const { client, transport } = await connect();
    try {
      await client.callTool({
        name: "code_patch",
        arguments: { anchor: `<resistor name="R1"`, replacement: `<resistor name="R1" resistance={` },
      });
    } finally {
      await transport.close();
    }
    const out = await callFab({});
    expect(out.errors).toBeGreaterThanOrEqual(1);
    expect(out.ready).toBe(false);
    expect(out.message).toMatch(/compile en erreur/);
  }, 90000);

  test("#39 — DRC rouge (placement overlap) → fab_export bloqué, aucun fichier", async () => {
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
    const out = await callFab({});
    expect(out.ready).toBe(false);
    expect(out.errors).toBeGreaterThanOrEqual(1);
    expect(out.message).toMatch(/DRC rouge/);
    expect(out.exportDir).toBe("");
    expect(out.artifacts).toEqual([]);
  }, 120000);
});
