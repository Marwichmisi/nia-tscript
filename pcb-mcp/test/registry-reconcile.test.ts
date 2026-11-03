// Ticket #38 — réconciliation boot : orphelin explicite, jamais supprimé
// silencieusement, `current` réinitialisé si introuvable, parent exposé.
// Seam : `pcb-mcp/src/project.ts` (observable disque + structures).
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyRegistry,
  listProjects,
  loadRegistry,
  reconcileRegistry,
  saveRegistry,
  upsertRegistry,
  writeLockProjectPath,
  currentProjectPath,
} from "../src/project";

let tmpRoot = "";
let regFile = "";
let lockFile = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nia-reconcile-"));
  regFile = path.join(tmpRoot, "projects.json");
  lockFile = path.join(tmpRoot, "mcp.json");
  process.env.NIATSCIRCUIT_PROJECTS_FILE = regFile;
  process.env.NIATSCIRCUIT_MCP_LOCK = lockFile;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.NIATSCIRCUIT_PROJECTS_FILE;
  delete process.env.NIATSCIRCUIT_MCP_LOCK;
});

describe("reconcileRegistry", () => {
  test("orphelin conservé + signalé, jamais supprimé", () => {
    const gone = path.join(tmpRoot, "supprime");
    const reg = upsertRegistry(emptyRegistry(), gone, "2026-01-01T00:00:00Z");
    const out = reconcileRegistry(reg);
    expect(out.orphans).toEqual([gone]);
    // L'entrée est TOUJOURS là (Oublier explicite, pas de purge silencieuse).
    expect(out.registry.projects.map((e) => e.path)).toEqual([gone]);
  });

  test("lastOpened orphelin → réinitialisé sur premier existant, sinon null", () => {
    const gone = path.join(tmpRoot, "gone");
    const alive = path.join(tmpRoot, "alive");
    fs.mkdirSync(alive, { recursive: true });
    let reg = upsertRegistry(emptyRegistry(), gone, "2026-01-01T00:00:00Z");
    reg = upsertRegistry(reg, alive, "2026-01-02T00:00:00Z");
    // Force un lastOpened orphelin (suppression entre-temps).
    fs.rmSync(alive, { recursive: true, force: true });
    const out = reconcileRegistry(reg);
    expect(out.currentReset).toBe(true);
    expect(out.registry.lastOpened).toBeNull();
    // Cas mixte : un vivant subsiste → il devient current.
    const alive2 = path.join(tmpRoot, "alive2");
    fs.mkdirSync(alive2, { recursive: true });
    let reg2 = upsertRegistry(emptyRegistry(), gone, "2026-01-01T00:00:00Z");
    reg2 = upsertRegistry(reg2, alive2, "2026-01-02T00:00:00Z");
    reg2.lastOpened = gone;
    const out2 = reconcileRegistry(reg2);
    expect(out2.registry.lastOpened).toBe(alive2);
  });

  test("registre sain → inchangé (pas de réécriture)", () => {
    const alive = path.join(tmpRoot, "ok");
    fs.mkdirSync(alive, { recursive: true });
    const reg = upsertRegistry(emptyRegistry(), alive, "2026-01-01T00:00:00Z");
    const out = reconcileRegistry(reg);
    expect(out.orphans).toEqual([]);
    expect(out.currentReset).toBe(false);
    expect(out.registry).toEqual(reg);
  });
});

describe("listProjects + current (Accueil)", () => {
  test("expose exists + parent (homonymes distinguables)", () => {
    const a = path.join(tmpRoot, "parent-a", "doublon");
    const b = path.join(tmpRoot, "parent-b", "doublon");
    fs.mkdirSync(a, { recursive: true });
    let reg = upsertRegistry(emptyRegistry(), a, "2026-01-01T00:00:00Z");
    reg = upsertRegistry(reg, b, "2026-01-02T00:00:00Z");
    saveRegistry(reg);
    const list = listProjects();
    expect(list.projects).toHaveLength(2);
    const byPath = Object.fromEntries(list.projects.map((p) => [p.path, p]));
    expect(byPath[a]!.exists).toBe(true);
    expect(byPath[a]!.name).toBe("doublon");
    expect(byPath[a]!.parent).toBe(path.join(tmpRoot, "parent-a"));
    expect(byPath[b]!.exists).toBe(false);
    expect(byPath[b]!.parent).toBe(path.join(tmpRoot, "parent-b"));
  });

  test("current réinitialisé si dossier supprimé (orphelin → Accueil)", () => {
    const dir = path.join(tmpRoot, "ephemere");
    fs.mkdirSync(dir, { recursive: true });
    writeLockProjectPath(dir);
    expect(currentProjectPath()).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(currentProjectPath()).toBeNull();
  });

  test("listProjects répare un lastOpened orphelin persisté", () => {
    const gone = path.join(tmpRoot, "gone2");
    const alive = path.join(tmpRoot, "alive3");
    fs.mkdirSync(alive, { recursive: true });
    let reg = upsertRegistry(emptyRegistry(), gone, "2026-01-01T00:00:00Z");
    reg = upsertRegistry(reg, alive, "2026-01-02T00:00:00Z");
    reg.lastOpened = gone;
    saveRegistry(reg);
    const list = listProjects();
    expect(list.lastOpened).toBe(alive);
    expect(loadRegistry().lastOpened).toBe(alive);
  });
});
