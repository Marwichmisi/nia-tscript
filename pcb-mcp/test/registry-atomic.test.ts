// Ticket #38 — Registre + lockfile atomiques, normalisation canonique unique.
// Seam : `pcb-mcp/src/project.ts` (lecture/écriture fichiers, observable disque).
// - tmp+rename+sync : kill en pleine écriture → fichier cible intact (jamais tronqué).
// - canonicalisation : même chemin sous plusieurs formes → une seule entrée Registre.
// - restart : relecture à froid depuis le disque (pas de cache mémoire).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalProjectPath,
  emptyRegistry,
  loadRegistry,
  registryPath,
  saveRegistry,
  upsertRegistry,
  writeLockProjectPath,
  currentProjectPath,
  lockfilePath,
} from "../src/project";

let tmpRoot = "";
let regFile = "";
let lockFile = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nia-reg-atomic-"));
  regFile = path.join(tmpRoot, "projects.json");
  lockFile = path.join(tmpRoot, "mcp.json");
  process.env.NIATSCIRCUIT_PROJECTS_FILE = regFile;
  process.env.NIATSCIRCUIT_MCP_LOCK = lockFile;
});

afterEach(() => {
  delete process.env.NIATSCIRCUIT_PROJECTS_FILE;
  delete process.env.NIATSCIRCUIT_MCP_LOCK;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("canonicalisation unique", () => {
  test("slash final et segments . absorbés → une seule forme", () => {
    const a = canonicalProjectPath(path.join(tmpRoot, "proj") + path.sep);
    const b = canonicalProjectPath(path.join(tmpRoot, "proj"));
    expect(a).toBe(b);
    expect(a.endsWith(path.sep) && a.length > 1).toBe(false);
  });

  test("refuse vide / relatif / traversal comme validate", () => {
    expect(() => canonicalProjectPath("")).toThrow();
    expect(() => canonicalProjectPath("relatif/x")).toThrow();
    expect(() => canonicalProjectPath("/tmp/../etc")).toThrow();
  });

  test("symlink résolu quand le dossier existe (même règle que Rust)", () => {
    const real = path.join(tmpRoot, "reel");
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(tmpRoot, "lien");
    try {
      fs.symlinkSync(real, link, "dir");
    } catch {
      return; // FS sans symlink (Windows restreint) : skip.
    }
    expect(canonicalProjectPath(link)).toBe(canonicalProjectPath(real));
  });

  test("upsert déduplique les formes slash-final", () => {
    const dir = path.join(tmpRoot, "dup");
    fs.mkdirSync(dir, { recursive: true });
    let reg = emptyRegistry();
    reg = upsertRegistry(reg, dir + path.sep);
    reg = upsertRegistry(reg, dir);
    expect(reg.projects).toHaveLength(1);
    expect(reg.lastOpened).toBe(canonicalProjectPath(dir));
  });
});

describe("écriture atomique", () => {
  test("saveRegistry/loadRegistry roundtrip + aucun .tmp résiduel", () => {
    const dir = path.join(tmpRoot, "a");
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    saveRegistry(upsertRegistry(emptyRegistry(), dir, now));
    expect(loadRegistry()).toEqual(upsertRegistry(emptyRegistry(), dir, now));
    const leftovers = fs.readdirSync(tmpRoot).filter((n) => n.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  test("crash simulé (tmp abandonné) → cible intacte et lisible", () => {
    const dir = path.join(tmpRoot, "b");
    fs.mkdirSync(dir, { recursive: true });
    const before = upsertRegistry(emptyRegistry(), dir);
    saveRegistry(before);
    // Simule un kill en pleine écriture : tmp écrit mais jamais renommé.
    fs.writeFileSync(regFile + ".12345.tmp", '{"projects": [{BROKEN');
    expect(loadRegistry()).toEqual(before);
    expect(() => JSON.parse(fs.readFileSync(regFile, "utf8"))).not.toThrow();
  });

  test("rafale d'écritures → fichier toujours valide (restart = relecture disque)", () => {
    for (let i = 0; i < 25; i++) {
      const d = path.join(tmpRoot, `p${i}`);
      fs.mkdirSync(d, { recursive: true });
      saveRegistry(upsertRegistry(loadRegistry(), d));
      // Relecture immédiate : jamais de JSON tronqué.
      expect(() => loadRegistry()).not.toThrow();
    }
    const reloaded = loadRegistry();
    expect(reloaded.projects).toHaveLength(25);
    expect(reloaded.lastOpened).toBe(canonicalProjectPath(path.join(tmpRoot, "p24")));
  });

  test("écritures concurrentes → JSON valide (last-writer-wins, jamais corrompu)", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const d = path.join(tmpRoot, `c${i}`);
        fs.mkdirSync(d, { recursive: true });
        return Promise.resolve().then(() => saveRegistry(upsertRegistry(loadRegistry(), d)));
      }),
    );
    const raw = fs.readFileSync(regFile, "utf8");
    const parsed = JSON.parse(raw) as { projects: unknown[] };
    expect(Array.isArray(parsed.projects)).toBe(true);
    expect(parsed.projects.length).toBeGreaterThan(0);
  });

  test("lockfile atomique : écriture + relecture + aucun .tmp", () => {
    const dir = path.join(tmpRoot, "lock");
    fs.mkdirSync(dir, { recursive: true });
    writeLockProjectPath(dir);
    expect(currentProjectPath()).toBe(canonicalProjectPath(dir));
    const leftovers = fs.readdirSync(tmpRoot).filter((n) => n.includes(".tmp."));
    expect(leftovers).toEqual([]);
    expect(fs.readFileSync(lockFile, "utf8")).toContain("projectPath");
  });

  test("lockfile corrompu/absent → null sans throw (stale = Accueil, pas crash)", () => {
    expect(currentProjectPath()).toBeNull();
    fs.writeFileSync(lockFile, "{ pas du json");
    expect(currentProjectPath()).toBeNull();
    fs.writeFileSync(lockFile, JSON.stringify({ url: "http://x", token: "t" }));
    expect(currentProjectPath()).toBeNull();
  });

  test("registryPath honore l'override d'isolation", () => {
    expect(registryPath()).toBe(regFile);
    expect(lockfilePath()).toBe(lockFile);
  });
});

describe("revue #37 item 7 — écrivains sidecar via helpers atomiques seuls", () => {
  const srcDir = path.resolve(import.meta.dir, "..", "src");
  const readSrc = (f: string) => fs.readFileSync(path.join(srcDir, f), "utf8");

  test("écritures directes limitées à logs/captures/exports + tmp atomique", () => {
    const writers = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /writeFileSync|appendFileSync/.test(readSrc(f)))
      .sort();
    expect(writers).toEqual(["log.ts", "mcp.ts", "preview.ts", "project.ts"]);
    // project.ts : le seul write direct est le tmp de l'helper atomique.
    const project = readSrc("project.ts");
    expect(project.match(/writeFileSync/g)?.length).toBe(1);
    expect(project.indexOf("export function atomicWriteFileSync")).toBeLessThan(
      project.indexOf("fs.writeFileSync(fd, content)"),
    );
  });

  test("Registre/lockfile/Projet persistés uniquement via helpers atomiques", () => {
    const project = readSrc("project.ts");
    for (const fn of ["saveRegistry", "writeLockProjectPath", "persistProjectFiles", "ensureProjectLayout"]) {
      const at = project.indexOf(`export function ${fn}`);
      expect(at, fn).toBeGreaterThanOrEqual(0);
      const next = project.indexOf("export function", at + 1);
      const body = project.slice(at, next === -1 ? undefined : next);
      expect(body, fn).toContain("atomicWriteFileSync");
    }
    // Chemins résolus uniquement dans project.ts (pas de contournement).
    for (const f of ["mcp.ts", "state.ts", "server.ts", "http.ts", "queue.ts", "log.ts"]) {
      expect(readSrc(f), f).not.toMatch(/registryPath\(\)|lockfilePath\(\)/);
    }
  });
});
