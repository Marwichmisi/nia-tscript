// Projets dossier côté sidecar (Seam B pur + I/O partagée avec Tauri).
// Registre + lockfile vivent sous base cache `niatscircuit/` (même raison que
// bug #25 : pont externe doit calculer le même chemin que Rust).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAIN_FILE = "main.tsx";
export const CIRCUIT_FILE = "circuit.json";
export const PREVIEWS_DIR = "previews";
export const EXPORTS_DIR = "exports";

export const NO_PROJECT_OPEN = "NO_PROJECT_OPEN";

export const EMPTY_CODE = `export default () => (
  <board width="20mm" height="20mm" />
)
`;

export const DEMO_CODE = `export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={-4} />
    <chip name="U1" footprint="sot23" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .pin1" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin3" to="net.VCC" />
  </board>
)
`;

export function templateCode(template: string): string | null {
  const t = (template ?? "").trim().toLowerCase();
  if (t === "" || t === "vide" || t === "empty") return EMPTY_CODE;
  if (t === "demo" || t === "gabarit démo" || t === "gabarit-demo") return DEMO_CODE;
  return null;
}

/** Refuse vide/relatif/`..`, retourne chemin absolu normalisé. */
export function validateProjectPath(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) throw new Error("chemin projet vide");
  if (!path.isAbsolute(raw)) throw new Error("chemin absolu requis");
  const normalized = path.normalize(raw);
  const parts = normalized.split(path.sep);
  if (parts.includes("..")) throw new Error("traversal .. refusé");
  return normalized;
}

export function baseCacheDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

export function registryPath(): string {
  const override = (process.env.NIATSCIRCUIT_PROJECTS_FILE ?? "").trim();
  if (override) return override;
  return path.join(baseCacheDir(), "niatscircuit", "projects.json");
}

export function lockfilePath(): string {
  const override = (process.env.NIATSCIRCUIT_MCP_LOCK ?? "").trim();
  if (override) return override;
  return path.join(baseCacheDir(), "niatscircuit", "mcp.json");
}

export interface RegistryEntry {
  path: string;
  lastOpened: string;
}

export interface Registry {
  projects: RegistryEntry[];
  lastOpened: string | null;
}

export function emptyRegistry(): Registry {
  return { projects: [], lastOpened: null };
}

export function loadRegistry(file?: string): Registry {
  const p = file ?? registryPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return emptyRegistry();
    const data = JSON.parse(raw) as Partial<Registry>;
    if (!Array.isArray(data.projects)) return emptyRegistry();
    return {
      projects: data.projects.filter((e) => typeof e?.path === "string"),
      lastOpened: typeof data.lastOpened === "string" ? data.lastOpened : null,
    };
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(reg: Registry, file?: string): void {
  const p = file ?? registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(reg, null, 2));
}

export function upsertRegistry(reg: Registry, projectPath: string, now = new Date().toISOString()): Registry {
  const p = validateProjectPath(projectPath);
  const next: Registry = {
    projects: [...reg.projects.filter((e) => e.path !== p), { path: p, lastOpened: now }],
    lastOpened: p,
  };
  next.projects.sort((a, b) => (b.lastOpened < a.lastOpened ? -1 : 1));
  return next;
}

export interface ProjectListItem extends RegistryEntry {
  name: string;
  exists: boolean;
}

/** Liste depuis Registre avec flag orphelin (dossier absent). */
export function listProjects(file?: string): { projects: ProjectListItem[]; lastOpened: string | null } {
  const reg = loadRegistry(file);
  const projects: ProjectListItem[] = reg.projects.map((e) => ({
    ...e,
    name: path.basename(e.path),
    exists: fs.existsSync(e.path),
  }));
  return { projects, lastOpened: reg.lastOpened };
}

/** Projet courant : lockfile `projectPath` > env `PCB_MCP_PROJECT_DIR` > null. */
export function currentProjectPath(): string | null {
  try {
    const raw = fs.readFileSync(lockfilePath(), "utf8");
    const data = JSON.parse(raw) as { projectPath?: unknown };
    if (typeof data.projectPath === "string" && data.projectPath.trim()) {
      return validateProjectPath(data.projectPath);
    }
  } catch {
    // lockfile absent/invalide = pas de projet, pas d'exception.
  }
  const env = (process.env.PCB_MCP_PROJECT_DIR ?? "").trim();
  if (env) {
    try {
      return validateProjectPath(env);
    } catch {
      return null;
    }
  }
  return null;
}

export function requireProjectPath(): string {
  const p = currentProjectPath();
  if (!p) {
    const err = new Error("aucun projet ouvert : ouvre un projet dans l'app ou via project_open");
    (err as Error & { code?: string }).code = NO_PROJECT_OPEN;
    throw err;
  }
  return p;
}

/** Écrit lockfile.projectPath best-effort (partage Rust ↔ sidecar). Crée un lockfile minimal en test quand absent. */
export function writeLockProjectPath(projectPath: string | null, file?: string): void {
  const p = file ?? lockfilePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (projectPath) data.projectPath = projectPath;
    else delete data.projectPath;
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return;
  } catch {
    // lockfile absent (tests bun sans boot Tauri) : crée un minimal.
  }
  if (!projectPath) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ projectPath }, null, 2));
  } catch {
    // best-effort.
  }
}

export function projectMainPath(projectPath: string): string {
  return path.join(projectPath, MAIN_FILE);
}

export function projectCircuitPath(projectPath: string): string {
  return path.join(projectPath, CIRCUIT_FILE);
}

export function projectPreviewsDir(projectPath: string): string {
  return path.join(projectPath, PREVIEWS_DIR);
}

export function projectExportsDir(projectPath: string): string {
  return path.join(projectPath, EXPORTS_DIR);
}

/** Crée layout, refuse non-vide sans main.tsx. Retourne "created" | "exists". */
export function ensureProjectLayout(projectPath: string, template: string): "created" | "exists" {
  const dir = validateProjectPath(projectPath);
  const code = templateCode(template);
  if (code === null) throw new Error(`gabarit inconnu "${template}" (attendus : vide, demo)`);
  const main = path.join(dir, MAIN_FILE);
  fs.mkdirSync(path.join(dir, PREVIEWS_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, EXPORTS_DIR), { recursive: true });
  if (fs.existsSync(main)) return "exists";
  const existed = fs.existsSync(dir);
  if (existed) {
    const entries = fs.readdirSync(dir).filter((n) => n !== PREVIEWS_DIR && n !== EXPORTS_DIR);
    if (entries.length > 0) throw new Error("dossier non-vide sans main.tsx : refuse d'écraser");
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(main, code);
  const circuit = path.join(dir, CIRCUIT_FILE);
  if (!fs.existsSync(circuit)) fs.writeFileSync(circuit, "[]");
  return "created";
}

/** Autosave best-effort après mutation réussie (main.tsx + circuit.json). */
export function persistProjectFiles(projectPath: string, code: string, circuitJson: unknown[]): void {
  const dir = validateProjectPath(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MAIN_FILE), code);
  fs.writeFileSync(path.join(dir, CIRCUIT_FILE), JSON.stringify(circuitJson));
}
