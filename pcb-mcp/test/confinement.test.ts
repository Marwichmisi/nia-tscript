// Confinement appliqué (ticket #42) : appartenance Registre après
// canonicalisation, partout.
// - Seam A (pur) : helpers `isProjectMember` / `assertProjectMember`
//   (miroir Rust : `is_project_member` / `assert_project_member`).
// - Seam B (outils MCP) : les 5 commandes dossier (code_patch, live_manage,
//   batch_execute, preview_screenshot, fab_export) refusent un Projet courant
//   hors Registre avec une erreur explicite.
// Source de vérité indépendante : spec #37 (Confinement) + glossaire.
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests } from "../src/state";
import {
  canonicalProjectPath,
  emptyRegistry,
  isProjectMember,
  assertProjectMember,
  loadRegistry,
  saveRegistry,
  upsertRegistry,
  writeLockProjectPath,
} from "../src/project";
import { ensureTestProject, setupIsolatedRegistry, type IsolatedEnv } from "./helpers";

let env: IsolatedEnv;

beforeEach(() => {
  env = setupIsolatedRegistry("nia-confine-");
});

afterEach(() => {
  env.restore();
});

describe("Confinement : appartenance Registre après canonicalisation", () => {
  test("membre reconnu sous toutes ses formes canoniques (slash final, symlink)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-conf-proj-"));
    saveRegistry(upsertRegistry(loadRegistry(), dir));
    expect(isProjectMember(dir)).toBe(true);
    expect(isProjectMember(dir + path.sep)).toBe(true);
    expect(assertProjectMember(dir + path.sep)).toBe(canonicalProjectPath(dir));
    const link = path.join(env.tmpRoot, "lien-projet");
    try {
      fs.symlinkSync(dir, link);
    } catch {
      // FS sans symlink (Windows sans droit) : le cas slash final suffit.
      return;
    }
    expect(isProjectMember(link)).toBe(true);
    expect(assertProjectMember(link)).toBe(canonicalProjectPath(dir));
  });

  test("hors périmètre refusé avec erreur explicite (ni lecture ni écriture)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nia-conf-hors-"));
    expect(isProjectMember(outside)).toBe(false);
    expect(() => assertProjectMember(outside)).toThrow(/hors périmètre/);
    try {
      assertProjectMember(outside);
    } catch (e) {
      expect((e as Error).message).toMatch(/Confinement/);
      expect((e as Error).message).toMatch(/Registre/);
    }
  });

  test("traversal refusé avant même le test d'appartenance", () => {
    expect(() => assertProjectMember("/tmp/../etc")).toThrow(/traversal/);
    expect(() => assertProjectMember("relatif/x")).toThrow(/absolu/);
  });

  test("retrait du Registre => aussitôt hors périmètre (pas de reste)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-conf-oublie-"));
    const reg = upsertRegistry(emptyRegistry(), dir);
    saveRegistry(reg);
    expect(isProjectMember(dir)).toBe(true);
    saveRegistry(emptyRegistry());
    expect(isProjectMember(dir)).toBe(false);
    expect(() => assertProjectMember(dir)).toThrow(/hors périmètre/);
  });

  test("registre explicite passé en argument (sans I/O globale)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-conf-arg-"));
    const reg = upsertRegistry(emptyRegistry(), dir);
    expect(isProjectMember(dir, reg)).toBe(true);
    expect(isProjectMember(dir)).toBe(false);
  });
});

const JAIL_TOKEN = "test-jail-" + Math.random().toString(36).slice(2);
let jailPort = 0;
let jailServer: Server;
let jailBaseUrl = "";
let jailEnv: IsolatedEnv;

function freeJailPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function callJailTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const client = new Client({ name: "test-jail-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(jailBaseUrl), {
    authProvider: { token: async () => JAIL_TOKEN },
  } as never);
  await client.connect(transport);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await transport.close();
  }
}

describe("Confinement : jail des 6 commandes dossier (MCP)", () => {
  let memberDir = "";
  let outsideDir = "";

  beforeAll(async () => {
    jailEnv = setupIsolatedRegistry("nia-jail-");
    jailPort = await freeJailPort();
    jailServer = await startServer({ port: jailPort, token: JAIL_TOKEN });
    jailBaseUrl = `http://127.0.0.1:${jailPort}/mcp`;
  });

  afterAll(() => {
    jailServer.close();
    jailEnv.restore();
  });

  beforeEach(() => {
    resetStoreForTests();
    memberDir = ensureTestProject("jail-proj");
    // Dossier réel (existant) mais JAMAIS enregistré : hors périmètre.
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-jail-hors-"));
  });

  async function withOutsideLock<T>(fn: () => Promise<T>): Promise<T> {
    writeLockProjectPath(outsideDir);
    try {
      return await fn();
    } finally {
      writeLockProjectPath(memberDir);
    }
  }

  test("code_patch hors périmètre → refus explicite, rien d'appliqué", async () => {
    const out = await withOutsideLock(() =>
      callJailTool("code_patch", { anchor: "<board", replacement: "<board" }),
    );
    expect(out["applied"]).toBe(false);
    expect(String(out["message"])).toMatch(/hors périmètre/);
    expect(String(out["message"])).toMatch(/Confinement/);
  });

  test("live_manage hors périmètre → refus explicite", async () => {
    const out = await withOutsideLock(() =>
      callJailTool("live_manage", { op: "select", refdes: "R1" }),
    );
    expect(String(out["message"] ?? JSON.stringify(out))).toMatch(/hors périmètre/);
  });

  test("batch_execute hors périmètre → refus explicite, rollback intact", async () => {
    const out = await withOutsideLock(() =>
      callJailTool("batch_execute", {
        operations: [{ kind: "patch", anchor: "<board", replacement: "<board" }],
      }),
    );
    expect(out["applied"]).toBe(false);
    expect(String(out["message"] ?? JSON.stringify(out))).toMatch(/hors périmètre/);
  });

  test("preview_screenshot hors périmètre → refus explicite", async () => {
    const out = await withOutsideLock(() =>
      callJailTool("preview_screenshot", { source: "pcb_2d" }),
    );
    expect(out["found"]).toBe(false);
    expect(String(out["message"])).toMatch(/hors périmètre/);
  });

  test("fab_export hors périmètre → refus explicite, aucun export", async () => {
    const out = await withOutsideLock(() => callJailTool("fab_export", {}));
    expect(out["ready"]).toBe(false);
    expect(String(out["message"] ?? JSON.stringify(out))).toMatch(/hors périmètre/);
  });

  test("search_parts hors périmètre → refus explicite (#review-3)", async () => {
    const out = await withOutsideLock(() => callJailTool("search_parts", { query: "R0603" }));
    expect(String(out["message"] ?? JSON.stringify(out))).toMatch(/hors périmètre/);
  });

  test("membre du Registre → pas de refus Confinement (repli existant intact)", async () => {
    const out = await callJailTool("preview_screenshot", { source: "pcb_2d" });
    expect(out["found"]).toBe(false);
    // Message d'absence (pas de capture déposée), PAS un refus de périmètre.
    expect(String(out["message"] ?? "")).not.toMatch(/hors périmètre/);
  });
});
