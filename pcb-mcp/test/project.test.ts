// Projets dossier : list/create/open/close + gating NO_PROJECT_OPEN + batch scopé.
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

const TOKEN = "test-proj-" + Math.random().toString(36).slice(2);
let PORT = 0;
let server: Server;
let baseUrl = "";
let tmpRoot = "";
let lockFile = "";
let regFile = "";
// Sauvegarde l'isolation externe éventuelle (ex NIATSCIRCUIT_MCP_LOCK posée
// par le harnais) : ce fichier l'écrase pour ses besoins puis la restaure,
// au lieu de la supprimer et de casser les suites qui suivent (#39).
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

async function connect() {
  const client = new Client({ name: "test-proj-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nia-proj-mcp-"));
  lockFile = path.join(tmpRoot, "mcp.json");
  regFile = path.join(tmpRoot, "projects.json");
  savedLock = process.env.NIATSCIRCUIT_MCP_LOCK;
  savedProjectsFile = process.env.NIATSCIRCUIT_PROJECTS_FILE;
  process.env.NIATSCIRCUIT_MCP_LOCK = lockFile;
  process.env.NIATSCIRCUIT_PROJECTS_FILE = regFile;
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

beforeEach(() => {
  resetStoreForTests();
  // Isole le projet courant entre tests (Accueil verrouillé par défaut).
  try {
    fs.rmSync(lockFile, { force: true });
  } catch { /* noop */ }
});

describe("Projets dossier + gating", () => {
  test("sans projet : project_list/current OK, code_patch refuse NO_PROJECT_OPEN", async () => {
    const list = await call("project_list");
    expect(Array.isArray(list["projects"])).toBe(true);
    const cur = await call("project_current");
    expect(cur["current"]).toBeNull();
    const patched = await call("code_patch", { anchor: "x", replacement: "y" });
    expect(patched["applied"]).toBe(false);
    expect(patched["code"]).toBe("NO_PROJECT_OPEN");
  });

  test("create vide → layout + current, batch scopé autosave", async () => {
    const dir = path.join(tmpRoot, "proj-a");
    const created = await call("project_create", { path: dir, template: "vide" });
    expect(created["path"]).toBe(dir);
    expect(created["current"]).toBe(dir);
    expect(fs.existsSync(path.join(dir, "main.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "previews"))).toBe(true);
    // batch vide refuse (pas NO_PROJECT) → preuve que le projet est bien ouvert.
    const batch = await call("batch_execute", { operations: [] });
    expect(batch["code"]).not.toBe("NO_PROJECT_OPEN");
  });

  test("create refuse dossier non-vide sans main.tsx", async () => {
    const dir = path.join(tmpRoot, "nonvide");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "ne pas écraser");
    let threw = false;
    try {
      await call("project_create", { path: dir, template: "vide" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("open/close : close reverrouille", async () => {
    const dir = path.join(tmpRoot, "proj-b");
    await call("project_create", { path: dir, template: "demo" });
    await call("project_close");
    const cur = await call("project_current");
    expect(cur["current"]).toBeNull();
    const state = await call("pcb_state");
    expect(state["code"]).toBe("NO_PROJECT_OPEN");
    await call("project_open", { path: dir });
    const cur2 = await call("project_current");
    expect(cur2["current"]).toBe(dir);
  });

  test("lockfile périmé (JSON cassé) → Accueil, pas de crash", async () => {
    fs.writeFileSync(lockFile, "{ cassé");
    const cur = await call("project_current");
    expect(cur["current"]).toBeNull();
    const list = await call("project_list");
    expect(Array.isArray(list["projects"])).toBe(true);
    const patched = await call("code_patch", { anchor: "x", replacement: "y" });
    expect(patched["code"]).toBe("NO_PROJECT_OPEN");
  });

  test("open avec circuit.json corrompu → erreur visible, projet non ouvert", async () => {
    const dir = path.join(tmpRoot, "proj-corrupt");
    await call("project_create", { path: dir, template: "vide" });
    await call("project_close");
    fs.writeFileSync(path.join(dir, "circuit.json"), "{ pas du json");
    let threw = false;
    try {
      await call("project_open", { path: dir });
    } catch {
      threw = true;
    }
    // Le contenu exact du message est couvert au niveau unitaire
    // (circuit-file.test.ts) ; ici le transport SDK remballe l'erreur.
    expect(threw).toBe(true);
    const cur = await call("project_current");
    expect(cur["current"]).toBeNull();
    // Fichier corrompu préservé, jamais écrasé silencieusement.
    expect(fs.readFileSync(path.join(dir, "circuit.json"), "utf8")).toBe("{ pas du json");
  });

  test("open recrée circuit.json absent (versionné)", async () => {
    const dir = path.join(tmpRoot, "proj-nocircuit");
    await call("project_create", { path: dir, template: "vide" });
    await call("project_close");
    fs.rmSync(path.join(dir, "circuit.json"), { force: true });
    await call("project_open", { path: dir });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "circuit.json"), "utf8")) as {
      version: number;
      circuitJson: unknown[];
    };
    expect(raw.version).toBe(1);
    expect(raw.circuitJson).toEqual([]);
  });

  test("project_list expose parent (homonymes distingués au niveau outil)", async () => {
    const a = path.join(tmpRoot, "pa", "dup");
    const b = path.join(tmpRoot, "pb", "dup");
    await call("project_create", { path: a, template: "vide" });
    await call("project_create", { path: b, template: "vide" });
    const list = await call("project_list");
    const projects = list["projects"] as Array<{ path: string; name: string; parent: string; exists: boolean }>;
    const got = Object.fromEntries(projects.filter((p) => p.path === a || p.path === b).map((p) => [p.path, p]));
    expect(got[a]!.name).toBe("dup");
    expect(got[b]!.name).toBe("dup");
    expect(got[a]!.parent).not.toBe(got[b]!.parent);
    expect(got[a]!.exists).toBe(true);
  });

  test("restart : redémarrage serveur → projet rouvert depuis le disque", async () => {
    const dir = path.join(tmpRoot, "proj-restart");
    await call("project_create", { path: dir, template: "vide" });
    // Le disque (lockfile + registre) est la seule mémoire : on tue et
    // relance le serveur, le Projet doit survivre.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    PORT = await freePort();
    server = await startServer({ port: PORT, token: TOKEN });
    baseUrl = `http://127.0.0.1:${PORT}/mcp`;
    const cur = await call("project_current");
    expect(cur["current"]).toBe(dir);
    const list = await call("project_list");
    const projects = list["projects"] as Array<{ path: string }>;
    expect(projects.some((p) => p.path === dir)).toBe(true);
  });
});
