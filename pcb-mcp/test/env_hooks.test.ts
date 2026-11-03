// Revue #37 item 4 — hooks env = TEST uniquement, repli SANS env DANS le Projet.
// Seam : helpers de résolution (aucune compile, aucune I/O réseau).
// Valeurs indépendantes : littéraux + chemins tmp, jamais recalculés par le
// code sous test.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import os from "node:os";
import path from "node:path";
import { fabExportBaseDir } from "../src/fab";
import { previewDir } from "../src/preview";
import { currentProjectPath, projectExportDir, projectPreviewsDir } from "../src/project";
import { setupIsolatedRegistry, ensureTestProject, type IsolatedEnv } from "./helpers";

let env: IsolatedEnv;
let savedExportDir: string | undefined;
let savedPreviewDir: string | undefined;
let savedProjectDir: string | undefined;

beforeEach(() => {
  env = setupIsolatedRegistry("nia-envhooks-");
  savedExportDir = process.env.PCB_MCP_EXPORT_DIR;
  savedPreviewDir = process.env.PCB_MCP_PREVIEW_DIR;
  savedProjectDir = process.env.PCB_MCP_PROJECT_DIR;
  delete process.env.PCB_MCP_EXPORT_DIR;
  delete process.env.PCB_MCP_PREVIEW_DIR;
  delete process.env.PCB_MCP_PROJECT_DIR;
});

afterEach(() => {
  if (savedExportDir === undefined) delete process.env.PCB_MCP_EXPORT_DIR;
  else process.env.PCB_MCP_EXPORT_DIR = savedExportDir;
  if (savedPreviewDir === undefined) delete process.env.PCB_MCP_PREVIEW_DIR;
  else process.env.PCB_MCP_PREVIEW_DIR = savedPreviewDir;
  if (savedProjectDir === undefined) delete process.env.PCB_MCP_PROJECT_DIR;
  else process.env.PCB_MCP_PROJECT_DIR = savedProjectDir;
  env.restore();
});

describe("#review-4 — SANS env, la résolution tombe DANS le Projet", () => {
  test("sans PCB_MCP_PROJECT_DIR, le lockfile désigne le Projet (aucun repli global)", () => {
    const dir = ensureTestProject("envhooks-proj");
    expect(currentProjectPath()).toBe(dir);
  });

  test("sans PCB_MCP_PROJECT_DIR ni lockfile, aucun projet (Accueil), jamais de chemin fantôme", () => {
    expect(currentProjectPath()).toBeNull();
  });

  test("sans PCB_MCP_EXPORT_DIR, projectExportDir reste dans le projet", () => {
    const dir = ensureTestProject("envhooks-export");
    const out = projectExportDir(dir);
    expect(out.startsWith(dir + path.sep)).toBe(true);
  });

  test("sans PCB_MCP_PREVIEW_DIR, projectPreviewsDir reste dans le projet", () => {
    const dir = ensureTestProject("envhooks-preview");
    expect(projectPreviewsDir(dir).startsWith(dir + path.sep)).toBe(true);
  });

  test("helpers globaux SANS env = cache global documenté (jamais implicite projet)", () => {
    expect(fabExportBaseDir()).toBe(path.join(os.tmpdir(), "niatscircuit-exports"));
    expect(previewDir()).toBe(path.join(os.tmpdir(), "niatscircuit-previews"));
  });

  test("hooks env posés = prioritaires (contrat des suites historiques)", () => {
    process.env.PCB_MCP_EXPORT_DIR = path.join(os.tmpdir(), "nia-envhooks-fab");
    process.env.PCB_MCP_PREVIEW_DIR = path.join(os.tmpdir(), "nia-envhooks-prev");
    expect(fabExportBaseDir()).toBe(path.join(os.tmpdir(), "nia-envhooks-fab"));
    expect(previewDir()).toBe(path.join(os.tmpdir(), "nia-envhooks-prev"));
  });
});
