// S43 — Resync temps réel : watcher → événement → relecture (ticket #43).
// Couture primaire (spec #37) : appel d'outil → disque → payload
// d'événement {path, hash} → relecture conditionnelle. Comportement externe
// uniquement (disque + événements observables), sans WebView ni réseau.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer as createTcpServer } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../src/http";
import { resetStoreForTests, getCode, setCode } from "../src/state";
import { BOARD_CODE } from "../src/board";
import {
  buildMainChangedEvent,
  ensureProjectLayout,
  hashMainCode,
  loadRegistry,
  projectMainPath,
  readMainWithHash,
  rereadMainIfChanged,
  saveRegistry,
  upsertRegistry,
  writeLockProjectPath,
} from "../src/project";
import { ensureTestProject, setupIsolatedRegistry, type IsolatedEnv } from "./helpers";

const TOKEN = "test-resync-" + Math.random().toString(36).slice(2);
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
  const client = new Client({ name: "test-resync-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    authProvider: { token: async () => TOKEN },
  } as never);
  await client.connect(transport);
  return { client, transport };
}

type PatchOutput = {
  applied: boolean;
  errors: number;
  diagnostics: Array<{ severity: string; message: string; source: string }>;
  circuitJson: unknown[];
};

async function callPatch(args: Record<string, unknown>): Promise<PatchOutput> {
  const { client, transport } = await connect();
  try {
    const res = await client.callTool({ name: "code_patch", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as PatchOutput;
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  env = setupIsolatedRegistry("nia-resync-");
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
  // Projet explicite (ticket #38) : sans lui, gating = vrai NO_PROJECT_OPEN.
  ensureTestProject();
});

describe("S43 — hash + événement + relecture (pur/disque)", () => {
  test("hashMainCode stable (sha256 hex)", () => {
    expect(hashMainCode("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashMainCode("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hashMainCode("abc")).toBe(hashMainCode("abc"));
    expect(hashMainCode("abd")).not.toBe(hashMainCode("abc"));
  });

  test("readMainWithHash relit disque + hash cohérent", () => {
    const dir = ensureTestProject();
    const marker = BOARD_CODE.replace("10k", "HASH-PROBE");
    fs.writeFileSync(projectMainPath(dir), marker);
    const got = readMainWithHash(dir);
    expect(got.code).toBe(marker);
    expect(got.hash).toBe(hashMainCode(marker));
    expect(got.path).toBe(projectMainPath(dir));
  });

  test("rereadMainIfChanged sans changement → changed:false", () => {
    const dir = ensureTestProject();
    const { hash } = readMainWithHash(dir);
    const got = rereadMainIfChanged(dir, hash);
    expect(got.changed).toBe(false);
    expect(got.code).toBe(fs.readFileSync(projectMainPath(dir), "utf8"));
    expect(got.hash).toBe(hash);
  });

  test("rereadMainIfChanged après écriture externe → changed:true", () => {
    const dir = ensureTestProject();
    const before = readMainWithHash(dir);
    const external = before.code.replace("10k", "47k");
    // Écriture externe (autre écrivain) : la mémoire reste périmée.
    fs.writeFileSync(projectMainPath(dir), external);
    expect(getCode()).not.toBe(external);
    const got = rereadMainIfChanged(dir, before.hash);
    expect(got.changed).toBe(true);
    expect(got.code).toBe(external);
    setCode(got.code);
    expect(getCode()).toBe(external);
  });

  test("buildMainChangedEvent payload {path, hash}", () => {
    const dir = ensureTestProject();
    const code = fs.readFileSync(projectMainPath(dir), "utf8");
    const evt = buildMainChangedEvent(dir, code);
    expect(evt).toEqual({ path: projectMainPath(dir), hash: hashMainCode(code) });
  });
});

describe("S43 — round-trip agent patch → disque → événement → relecture", () => {
  test("code_patch valide → disque → événement → re-read mémoire", async () => {
    const dir = ensureTestProject();
    const out = await callPatch({
      anchor: `resistance="10k" footprint="0402" pcbX={-5} pcbY={4}`,
      replacement: `resistance="4.7k" footprint="0402" pcbX={-5} pcbY={4}`,
    });
    expect(out.applied).toBe(true);
    // 1. Disque à jour.
    const disk = fs.readFileSync(projectMainPath(dir), "utf8");
    expect(disk).toContain(`resistance="4.7k"`);
    // 2. Payload d'événement construit depuis le disque.
    const evt = buildMainChangedEvent(dir, disk);
    expect(evt.hash).toBe(hashMainCode(disk));
    // 3. Mémoire périmée → relecture conditionnelle resynchronise.
    const staleHash = hashMainCode(BOARD_CODE);
    setCode(BOARD_CODE);
    const reread = rereadMainIfChanged(dir, staleHash);
    expect(reread.changed).toBe(true);
    setCode(reread.code);
    expect(getCode()).toBe(disk);
    // 4. Même hash → pas de relecture.
    expect(rereadMainIfChanged(dir, evt.hash).changed).toBe(false);
  }, 60000);

  test("persistance non silencieuse : disque KO → applied:false + erreur explicite", async () => {
    // Projet dédié (le main.tsx partagé reste intact pour les autres tests).
    const dir2 = path.join(path.dirname(env.lockFile), "ko-proj");
    ensureProjectLayout(dir2, "vide");
    fs.writeFileSync(projectMainPath(dir2), BOARD_CODE);
    saveRegistry(upsertRegistry(loadRegistry(), dir2));
    writeLockProjectPath(dir2);
    setCode(BOARD_CODE);
    // Disque KO : main.tsx remplacé par un dossier (écriture impossible).
    const main = projectMainPath(dir2);
    fs.rmSync(main);
    fs.mkdirSync(main);
    try {
      const out = await callPatch({
        anchor: `width="20mm"`,
        replacement: `width="21mm"`,
      });
      expect(out.applied).toBe(false);
      expect(out.diagnostics[0]!.message).toMatch(/disque/i);
      // Mémoire restaurée depuis le disque (jamais de divergence silencieuse).
      expect(getCode()).toBe(BOARD_CODE);
    } finally {
      fs.rmdirSync(main);
    }
  }, 60000);

  test("sidecar recharge le disque au boot", async () => {
    const dir = ensureTestProject();
    const marker = BOARD_CODE.replace("10k", "BOOT-RELOAD");
    fs.writeFileSync(projectMainPath(dir), marker);
    setCode("mémoire périmée");
    const port2 = await freePort();
    const server2 = await startServer({ port: port2, token: TOKEN });
    try {
      expect(getCode()).toBe(marker);
    } finally {
      server2.close();
    }
  });
});
