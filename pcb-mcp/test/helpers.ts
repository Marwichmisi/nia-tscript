// Helpers d'isolation Registre/lockfile + Projet explicite (ticket #38).
// Fini la fixture masquante : `resetStoreForTests` ne crée plus de Projet ;
// les suites qui en ont besoin appellent `ensureTestProject` (geste explicite).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOARD_CODE } from "../src/board";
import { setCode } from "../src/state";
import {
  ensureProjectLayout,
  loadRegistry,
  projectMainPath,
  saveRegistry,
  upsertRegistry,
  writeLockProjectPath,
} from "../src/project";

export interface IsolatedEnv {
  tmpRoot: string;
  lockFile: string;
  regFile: string;
  restore(): void;
}

/** Isole Registre + lockfile dans un tmp (restaure l'env précédent). */
export function setupIsolatedRegistry(prefix = "nia-test-"): IsolatedEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const lockFile = path.join(tmpRoot, "mcp.json");
  const regFile = path.join(tmpRoot, "projects.json");
  const prevLock = process.env.NIATSCIRCUIT_MCP_LOCK;
  const prevReg = process.env.NIATSCIRCUIT_PROJECTS_FILE;
  process.env.NIATSCIRCUIT_MCP_LOCK = lockFile;
  process.env.NIATSCIRCUIT_PROJECTS_FILE = regFile;
  return {
    tmpRoot,
    lockFile,
    regFile,
    restore() {
      if (prevLock === undefined) delete process.env.NIATSCIRCUIT_MCP_LOCK;
      else process.env.NIATSCIRCUIT_MCP_LOCK = prevLock;
      if (prevReg === undefined) delete process.env.NIATSCIRCUIT_PROJECTS_FILE;
      else process.env.NIATSCIRCUIT_PROJECTS_FILE = prevReg;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Crée un Projet de test explicite (layout + TSX fixture disque+mémoire),
 *  l'enregistre au Registre isolé et l'ouvre (lockfile). Idempotent par nom. */
export function ensureTestProject(name = "test-proj"): string {
  const lock = (process.env.NIATSCIRCUIT_MCP_LOCK ?? "").trim();
  if (!lock) throw new Error("ensureTestProject exige un Registre isolé (setupIsolatedRegistry)");
  const dir = path.join(path.dirname(lock), name);
  ensureProjectLayout(dir, "vide");
  fs.writeFileSync(projectMainPath(dir), BOARD_CODE);
  saveRegistry(upsertRegistry(loadRegistry(), dir));
  writeLockProjectPath(dir);
  setCode(BOARD_CODE);
  return dir;
}

/** Reverrouille (Accueil) sans toucher au Registre. */
export function clearTestProject(): void {
  const lock = (process.env.NIATSCIRCUIT_MCP_LOCK ?? "").trim();
  if (lock) {
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      /* noop */
    }
  }
}
