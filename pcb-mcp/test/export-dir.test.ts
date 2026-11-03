// Ticket #38 — exports clés par hash du chemin canonique (fini la collision
// sur basename entre homonymes).
// Seam : helpers purs de `pcb-mcp/src/project.ts` (pas de compile lourde).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalProjectPath,
  hashCanonicalPath,
  projectExportDir,
} from "../src/project";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nia-exportdir-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("exports par hash du chemin canonique", () => {
  test("hash stable, hexadécimal, insensible au slash final", () => {
    const a = canonicalProjectPath(path.join(tmpRoot, "proj"));
    const h1 = hashCanonicalPath(a);
    const h2 = hashCanonicalPath(a);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]+$/);
    expect(h1.length).toBeGreaterThanOrEqual(8);
    expect(hashCanonicalPath(canonicalProjectPath(path.join(tmpRoot, "proj") + path.sep))).toBe(h1);
  });

  test("homonymes (même basename, parents différents) → dossiers distincts", () => {
    const a = path.join(tmpRoot, "parent-a", "doublon");
    const b = path.join(tmpRoot, "parent-b", "doublon");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const dirA = projectExportDir(a);
    const dirB = projectExportDir(b);
    expect(dirA).not.toBe(dirB);
    expect(dirA).toContain("doublon");
    expect(dirB).toContain("doublon");
  });

  test("même projet → même dossier (idempotent)", () => {
    const a = path.join(tmpRoot, "stable");
    fs.mkdirSync(a, { recursive: true });
    expect(projectExportDir(a)).toBe(projectExportDir(a + path.sep));
  });
});
