// Ticket #40 — build reproductible : versions épinglées, gates CI, sidecar vérifié.
// Spec #37 (Implementation Decisions → Build) : versions bun/node/rust épinglées
// (fini les flottants CI/local), gates `bun test` + `cargo test` + vérification de
// types avant build, vérification taille + permissions du sidecar après compilation,
// lockfile MCP régénéré (fini le décoratif stale).
// Couture testée (interfaces publiques, pas d'internes) :
//   - fichiers pin (.bun-version, .nvmrc, rust-toolchain.toml) == versions en dur en CI
//   - gates présents dans ci.yml + release.yml (texte des workflows)
//   - verify-sidecar.mjs : refuse absent/stub/world-writable, accepte binaire réel
//   - pcb-mcp/bun.lock : couvre toutes les dépendances réelles de package.json
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifySidecar, MIN_SIDECAR_BYTES } from "../scripts/verify-sidecar.mjs";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
// bun.lock admet des virgules finales (JSONC) : tolérance stricte à ce seul écart.
const parseLock = (text: string) => JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));

// Versions canoniques : source indépendante = amont vérifié le 2026-11-03
// (bun 1.3.11 installé localement + release GitHub existante,
//  node 22.23.4 = dernier 22.x sur nodejs.org, CI déjà en major 22,
//  rust 1.98.1 = rustc local + channel static.rust-lang.org répondant 200).
const PINNED = { bun: "1.3.11", node: "22.23.4", rust: "1.98.1" } as const;

describe("#40 — versions épinglées (fini les flottants CI/local)", () => {
  test("fichiers pin existent avec versions exactes (semver stricte, pas de range)", () => {
    expect(read(".bun-version").trim()).toBe(PINNED.bun);
    expect(read(".nvmrc").trim()).toBe(PINNED.node);
    const toolchain = read("rust-toolchain.toml");
    expect(toolchain).toMatch(/channel\s*=\s*"1\.98\.1"/);
    for (const v of Object.values(PINNED)) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("ci.yml + release.yml référencent exactement les versions pin", () => {
    for (const wf of ["ci.yml", "release.yml"]) {
      const yaml = read(`.github/workflows/${wf}`);
      expect(yaml).toContain(PINNED.bun);
      expect(yaml).toContain(PINNED.node);
      expect(yaml).toContain(PINNED.rust);
    }
  });

  test("aucun flottant toolchain en CI (latest/stable/bun-version absente)", () => {
    for (const wf of ["ci.yml", "release.yml"]) {
      const yaml = read(`.github/workflows/${wf}`);
      expect(yaml).not.toMatch(/bun-version:\s*latest/i);
      expect(yaml).not.toMatch(/node-version:\s*22(?!\.\d)/);
      expect(yaml).not.toMatch(/rust-toolchain@stable\s*\n\s*with:\s*\n\s*targets:/);
    }
  });
});

describe("#40 — gates bun test + cargo test + types avant build", () => {
  test("ci.yml : installs gelés + trois gates avant tout build", () => {
    const yaml = read(".github/workflows/ci.yml");
    expect(yaml).toContain("--frozen-lockfile");
    expect(yaml).toContain("bun test");
    expect(yaml).toContain("cargo test");
    expect(yaml).toContain("typecheck");
    // Ordre : les gates précèdent le build (positions dans le fichier).
    const gates = Math.max(
      yaml.indexOf("bun test"),
      yaml.indexOf("cargo test"),
      yaml.indexOf("typecheck"),
    );
    expect(gates).toBeGreaterThan(-1);
    expect(yaml.indexOf("scripts/build.mjs")).toBeGreaterThan(gates);
  });

  test("release.yml : versions gelées + gates + vérification sidecar après build", () => {
    const yaml = read(".github/workflows/release.yml");
    expect(yaml).toContain("--frozen-lockfile");
    expect(yaml).toContain("bun test");
    expect(yaml).toContain("cargo test");
    expect(yaml).toContain("typecheck");
    expect(yaml).toContain("verify-sidecar");
  });
});

describe("#40 — vérification sidecar (taille + permissions)", () => {
  test("seuil documenté : au moins 1 Mio (stub ≈ 150 o, binaire bun --compile ≈ dizaines de Mo)", () => {
    expect(MIN_SIDECAR_BYTES).toBeGreaterThanOrEqual(1_048_576);
  });

  test("binaire manquant → refus explicite", () => {
    const missing = path.join(os.tmpdir(), `nia-sidecar-manquant-${process.pid}`);
    expect(() => verifySidecar(missing)).toThrow(/introuvable|manquant|ENOENT/i);
  });

  test("stub (quelques octets) → refusé", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-sidecar-stub-"));
    const fp = path.join(dir, "pcb-mcp-x86_64-unknown-linux-gnu");
    fs.writeFileSync(fp, "#!/bin/sh\necho stub\n");
    fs.chmodSync(fp, 0o755);
    expect(() => verifySidecar(fp)).toThrow(/stub|taille/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("binaire world-writable → refusé même à taille suffisante", () => {
    if (process.platform === "win32") return; // Les bits POSIX ne s'appliquent pas sous Windows.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-sidecar-ww-"));
    const fp = path.join(dir, "pcb-mcp-x86_64-unknown-linux-gnu");
    fs.writeFileSync(fp, "x");
    fs.truncateSync(fp, MIN_SIDECAR_BYTES + 1);
    fs.chmodSync(fp, 0o777);
    expect(() => verifySidecar(fp)).toThrow(/world-writable|permissions/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("binaire réel (taille suffisante, 0o755) → accepté avec taille rapportée", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-sidecar-ok-"));
    const fp = path.join(dir, "pcb-mcp-x86_64-unknown-linux-gnu");
    fs.writeFileSync(fp, "x");
    fs.truncateSync(fp, MIN_SIDECAR_BYTES + 1);
    fs.chmodSync(fp, 0o755);
    const res = verifySidecar(fp);
    expect(res.size).toBe(MIN_SIDECAR_BYTES + 1);
    expect(res.worldWritable).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("#40 — lockfile MCP reflétant les dépendances réelles", () => {
  test("chaque dépendance de package.json est couverte par pcb-mcp/bun.lock", () => {
    const pkg = JSON.parse(read("pcb-mcp/package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lock = parseLock(read("pcb-mcp/bun.lock")) as {
      workspaces: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    };
    const locked = {
      ...(lock.workspaces[""]?.dependencies ?? {}),
      ...(lock.workspaces[""]?.devDependencies ?? {}),
    };
    const wanted = { ...pkg.dependencies, ...pkg.devDependencies };
    const missing = Object.keys(wanted).filter((d) => !(d in locked));
    expect(missing).toEqual([]);
  });

  test("aucune plage 'latest' dans pcb-mcp/package.json (jamais reproductible)", () => {
    const pkg = JSON.parse(read("pcb-mcp/package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const ranges = { ...pkg.dependencies, ...pkg.devDependencies };
    const floating = Object.entries(ranges).filter(([, r]) => r.trim() === "latest");
    expect(floating).toEqual([]);
  });
});
