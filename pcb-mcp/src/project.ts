// Projets dossier côté sidecar (Seam B pur + I/O partagée avec Tauri).
// Registre + lockfile vivent sous base cache `niatscircuit/` (même raison que
// bug #25 : pont externe doit calculer le même chemin que Rust).
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const MAIN_FILE = "main.tsx";
export const CIRCUIT_FILE = "circuit.json";
export const PREVIEWS_DIR = "previews";
export const EXPORTS_DIR = "exports";

/** Version du schéma `circuit.json` (spec #37, ticket #38). Le fichier disque
 *  est une enveloppe `{ version, circuitJson }` ; le tableau nu legacy est
 *  migré à l'ouverture, le corrompu est une erreur visible. */
export const CIRCUIT_SCHEMA_VERSION = 1;

export interface CircuitFile {
  version: number;
  circuitJson: unknown[];
}

/** Sérialise les éléments en enveloppe versionnée. */
export function serializeCircuitFile(circuitJson: unknown[]): string {
  return JSON.stringify({ version: CIRCUIT_SCHEMA_VERSION, circuitJson });
}

/** Parse strict : enveloppe versionnée ou tableau nu legacy (migré en mémoire).
 *  Throw `circuit.json …` visible dans tous les autres cas (corrompu, version
 *  inconnue, enveloppe invalide) — jamais de défaut silencieux. */
export function parseCircuitFile(text: string): CircuitFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("circuit.json corrompu (JSON illisible) : ouvrez le dossier pour inspecter, sans écrasement automatique");
  }
  if (Array.isArray(data)) return { version: CIRCUIT_SCHEMA_VERSION, circuitJson: data };
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if (obj["version"] !== CIRCUIT_SCHEMA_VERSION) {
      throw new Error(
        `circuit.json version ${String(obj["version"] ?? "absente")} non supportée (attendue : ${CIRCUIT_SCHEMA_VERSION})`,
      );
    }
    if (!Array.isArray(obj["circuitJson"])) {
      throw new Error("circuit.json corrompu (circuitJson absent ou invalide)");
    }
    return { version: CIRCUIT_SCHEMA_VERSION, circuitJson: obj["circuitJson"] as unknown[] };
  }
  throw new Error("circuit.json corrompu (ni enveloppe ni tableau)");
}

/** Relit les éléments du `circuit.json` d'un Projet. Throw si absent/corrompu. */
export function readCircuitFile(projectPath: string): unknown[] {
  const dir = validateProjectPath(projectPath);
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, CIRCUIT_FILE), "utf8");
  } catch {
    throw new Error(`circuit.json absent (${dir}) : rouvrez le Projet pour le recréer`);
  }
  if (!text.trim()) throw new Error(`circuit.json corrompu (${dir}) : fichier vide`);
  return parseCircuitFile(text).circuitJson;
}

/** Garantit un `circuit.json` versionné : "created" si recréé, "migrated" si
 *  le tableau nu legacy a été réécrit versionné, "exists" sinon.
 *  Corrompu → throw (erreur d'ouverture visible, fichier préservé). */
export function ensureCircuitFile(projectPath: string): "created" | "migrated" | "exists" {
  const dir = validateProjectPath(projectPath);
  const circuit = path.join(dir, CIRCUIT_FILE);
  if (!fs.existsSync(circuit)) {
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(circuit, serializeCircuitFile([]));
    return "created";
  }
  const text = fs.readFileSync(circuit, "utf8");
  if (!text.trim()) {
    throw new Error(`circuit.json corrompu (${dir}) : fichier vide — supprimez ou restaurez le fichier`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`circuit.json corrompu (${dir}) : JSON illisible — supprimez ou restaurez le fichier`);
  }
  if (Array.isArray(data)) {
    atomicWriteFileSync(circuit, serializeCircuitFile(data));
    return "migrated";
  }
  // Valide strictement (throw si version/enveloppe invalide).
  parseCircuitFile(text);
  return "exists";
}

export const NO_PROJECT_OPEN = "NO_PROJECT_OPEN";

/** Code d'erreur Confinement (ticket #42) : dossier existant mais hors
 *  Registre — ni lecture, ni écriture, ni capture. */
export const OUT_OF_SCOPE = "OUT_OF_SCOPE";

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

/** Refuse vide/relatif/`..`, retourne chemin absolu normalisé.
 *  Le `..` est refusé sur le brut AVANT normalisation (même règle que
 *  `validate_project_path` côté Rust) : `/tmp/../etc` est un traversal,
 *  même si la normalisation le résoudrait en `/etc`. */
export function validateProjectPath(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) throw new Error("chemin projet vide");
  if (!path.isAbsolute(raw)) throw new Error("chemin absolu requis");
  if (raw.split(/[/\\]/).includes("..")) throw new Error("traversal .. refusé");
  const normalized = path.normalize(raw);
  const parts = normalized.split(path.sep);
  if (parts.includes("..")) throw new Error("traversal .. refusé");
  return normalized;
}

/** Normalisation unique partagée (spec #37, ticket #38) : absolu, sans slash
 *  final, symlinks résolus quand le dossier existe. Le backend Rust applique
 *  la même règle (`canonical_project_path` dans `src-tauri/src/project.rs`).
 *  Toute entrée Registre/lockfile passe par ici (via `upsertRegistry`). */
export function canonicalProjectPath(input: string): string {
  const normalized = validateProjectPath(input);
  let stripped = normalized;
  const root = path.parse(stripped).root;
  while (stripped.length > root.length && stripped.endsWith(path.sep)) {
    stripped = stripped.slice(0, -path.sep.length);
  }
  try {
    return fs.realpathSync(stripped);
  } catch {
    return stripped;
  }
}

/** Écriture atomique (tmp + rename + fsync fichier + fsync dossier) : un kill
 *  en pleine écriture laisse l'ancien contenu intact ou le nouveau complet —
 *  jamais un JSON tronqué. Écrivain unique : tout write Registre/lockfile
 *  (`saveRegistry`, `writeLockProjectPath`) et toute persistance Projet
 *  (`persistProjectFiles`, `ensureProjectLayout`) passe par ici. */
export function atomicWriteFileSync(target: string, content: string | Buffer): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* FS sans fsync dossier (ex. Windows) : best-effort. */
  }
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
  atomicWriteFileSync(p, JSON.stringify(reg, null, 2));
}

export function upsertRegistry(reg: Registry, projectPath: string, now = new Date().toISOString()): Registry {
  const p = canonicalProjectPath(projectPath);
  const next: Registry = {
    projects: [...reg.projects.filter((e) => e.path !== p), { path: p, lastOpened: now }],
    lastOpened: p,
  };
  next.projects.sort((a, b) => (b.lastOpened < a.lastOpened ? -1 : 1));
  return next;
}

/** Confinement (spec #37, ticket #42) : une opération dossier n'est
 *  autorisée que si le chemin, APRÈS canonicalisation, est un Projet du
 *  Registre. Toute autre forme (slash final, symlink, `..` résolu) est
 *  ramenée au canonique avant le test — jamais de comparaison sur le brut.
 *  `reg` explicite = sans I/O (tests) ; sinon Registre chargé du disque. */
export function isProjectMember(input: string, reg?: Registry): boolean {
  let canonical: string;
  try {
    canonical = canonicalProjectPath(input);
  } catch {
    return false;
  }
  const registry = reg ?? loadRegistry();
  return registry.projects.some((e) => {
    try {
      return canonicalProjectPath(e.path) === canonical;
    } catch {
      return e.path === canonical;
    }
  });
}

/** Variante qui throw une erreur explicite hors périmètre (jamais de
 *  `NO_PROJECT_OPEN` silencieux : le dossier existe peut-être, mais il
 *  n'est pas un Projet du Registre). Retourne le chemin canonique. */
export function assertProjectMember(input: string, reg?: Registry): string {
  const canonical = canonicalProjectPath(input);
  if (isProjectMember(canonical, reg)) return canonical;
  throw new Error(
    `hors périmètre (Confinement) : ${canonical} — opération refusée, le dossier n'est pas un Projet du Registre`,
  );
}

export interface ProjectListItem extends RegistryEntry {
  name: string;
  /** Dossier parent complet (homonymes distingués dans l'Accueil). */
  parent: string;
  exists: boolean;
}

/** Dossier parent complet d'un chemin Projet ("" si racine). */
export function parentOfProjectPath(projectPath: string): string {
  const dir = path.dirname(projectPath);
  return dir === projectPath ? "" : dir;
}

export interface ReconciledRegistry {
  registry: Registry;
  /** Chemins du Registre dont le dossier est introuvable (orphelins). */
  orphans: string[];
  /** Vrai si `lastOpened` a été réinitialisé (pointait un orphelin). */
  currentReset: boolean;
}

/** Réconciliation boot (ticket #38) : existence vérifiée, orphelin explicite
 *  (conservé — l'Oubli est un geste explicite Relink/Oublier), `lastOpened`
 *  réinitialisé sur le premier Projet existant (sinon null).
 *  Ne touche jamais au disque (cf. `listProjects` pour la persistance). */
export function reconcileRegistry(reg: Registry): ReconciledRegistry {
  const orphans = reg.projects.filter((e) => !fs.existsSync(e.path)).map((e) => e.path);
  const orphanSet = new Set(orphans);
  let currentReset = false;
  let lastOpened = reg.lastOpened;
  if (lastOpened !== null && (orphanSet.has(lastOpened) || !reg.projects.some((e) => e.path === lastOpened))) {
    const firstAlive = reg.projects.find((e) => !orphanSet.has(e.path));
    lastOpened = firstAlive ? firstAlive.path : null;
    currentReset = true;
  }
  return { registry: { projects: reg.projects, lastOpened }, orphans, currentReset };
}

/** Liste depuis Registre avec flag orphelin (dossier absent) + parent.
 *  Réconcilie `lastOpened` et persiste la réparation (orphelins conservés). */
export function listProjects(file?: string): { projects: ProjectListItem[]; lastOpened: string | null } {
  const reg = loadRegistry(file);
  const { registry, currentReset } = reconcileRegistry(reg);
  if (currentReset) {
    try {
      saveRegistry(registry, file);
    } catch {
      /* réparation best-effort */
    }
  }
  const projects: ProjectListItem[] = registry.projects.map((e) => ({
    ...e,
    name: path.basename(e.path),
    parent: parentOfProjectPath(e.path),
    exists: fs.existsSync(e.path),
  }));
  return { projects, lastOpened: registry.lastOpened };
}

/** Projet courant : lockfile `projectPath` > env `PCB_MCP_PROJECT_DIR` > null.
 *  Dossier supprimé (orphelin) → null (Accueil), jamais de chemin fantôme. */
export function currentProjectPath(): string | null {
  try {
    const raw = fs.readFileSync(lockfilePath(), "utf8");
    const data = JSON.parse(raw) as { projectPath?: unknown };
    if (typeof data.projectPath === "string" && data.projectPath.trim()) {
      const p = validateProjectPath(data.projectPath);
      if (!fs.existsSync(p)) return null;
      return p;
    }
  } catch {
    // lockfile absent/invalide = pas de projet, pas d'exception.
  }
  const env = (process.env.PCB_MCP_PROJECT_DIR ?? "").trim();
  if (env) {
    try {
      const p = validateProjectPath(env);
      if (!fs.existsSync(p)) return null;
      return p;
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

/** Écrit lockfile.projectPath best-effort (partage Rust ↔ sidecar).
 * Prod : ne crée JAMAIS de lockfile (url/token requis pour le pont).
 * Ne patch que si un lock valide existe déjà (préserve url/token).
 * Tests isolés (`NIATSCIRCUIT_MCP_LOCK` ou `file` explicite) : minimal autorisé. */
export function writeLockProjectPath(projectPath: string | null, file?: string): void {
  const override = (process.env.NIATSCIRCUIT_MCP_LOCK ?? "").trim();
  const p = file ?? lockfilePath();
  const isTestIsolation = file !== undefined || override.length > 0;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (projectPath) data.projectPath = canonicalProjectPath(projectPath);
    else delete data.projectPath;
    atomicWriteFileSync(p, JSON.stringify(data, null, 2));
    return;
  } catch {
    // lockfile absent/invalide : en prod on ne crée rien (évite
    // d'écraser url/token par un minimal {projectPath} → -32000).
  }
  if (!isTestIsolation) return;
  if (!projectPath) return;
  try {
    atomicWriteFileSync(p, JSON.stringify({ projectPath: canonicalProjectPath(projectPath) }, null, 2));
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

/** Hash stable (sha256, 12 hex) du chemin canonique : clé d'exports qui
 *  distingue les homonymes (même basename, parents différents).
 *  Miroir documenté côté backend : même règle (sha256 du canonique). */
export function hashCanonicalPath(canonicalPath: string): string {
  return crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 12);
}

/** Dossier d'exports d'un Projet : `<projet>/exports/<basename>-<hash12>` —
 *  fini la collision sur basename entre homonymes. */
export function projectExportDir(projectPath: string): string {
  const canonical = canonicalProjectPath(projectPath);
  const base = path.basename(canonical) || "board";
  const safe = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "board";
  return path.join(projectExportsDir(canonical), `${safe}-${hashCanonicalPath(canonical)}`);
}

/** Crée layout, refuse non-vide sans main.tsx. Retourne "created" | "exists". */
export function ensureProjectLayout(projectPath: string, template: string): "created" | "exists" {
  const dir = validateProjectPath(projectPath);
  const code = templateCode(template);
  if (code === null) throw new Error(`gabarit inconnu "${template}" (attendus : vide, demo)`);
  const main = path.join(dir, MAIN_FILE);
  fs.mkdirSync(path.join(dir, PREVIEWS_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, EXPORTS_DIR), { recursive: true });
  if (fs.existsSync(main)) {
    // Projet existant : garantit quand même un circuit.json versionné
    // (legacy sans circuit, ou migration tableau nu).
    ensureCircuitFile(dir);
    return "exists";
  }
  const existed = fs.existsSync(dir);
  if (existed) {
    const entries = fs.readdirSync(dir).filter((n) => n !== PREVIEWS_DIR && n !== EXPORTS_DIR);
    if (entries.length > 0) throw new Error("dossier non-vide sans main.tsx : refuse d'écraser");
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(main, code);
  // circuit.json versionné (ticket #38) : jamais de tableau nu sur disque.
  ensureCircuitFile(dir);
  return "created";
}

/** Autosave best-effort après mutation réussie (main.tsx + circuit.json versionné, atomique). */
export function persistProjectFiles(projectPath: string, code: string, circuitJson: unknown[]): void {
  const dir = validateProjectPath(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path.join(dir, MAIN_FILE), code);
  atomicWriteFileSync(path.join(dir, CIRCUIT_FILE), serializeCircuitFile(circuitJson));
}

// --- Resync temps réel (ticket #43) ------------------------------------------
// Couture watcher → événement → relecture : le disque est la source unique de
// vérité, le hash décide seul de la relecture. Même règle de hash que le
// backend Rust (`hash_main_content` dans `src-tauri/src/watch.rs`).

/** Hash stable du contenu `main.tsx` (sha256 hex, 64 car.). */
export function hashMainCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

/** Payload d'événement `project-main-changed` : ce qui a changé + son hash.
 *  `path` = le `main.tsx` surveillé (pas le dossier), `hash` = son contenu. */
export interface MainChangedEvent {
  path: string;
  hash: string;
}

/** Construit le payload depuis le dossier Projet canonique + code disque. */
export function buildMainChangedEvent(projectPath: string, code: string): MainChangedEvent {
  const dir = canonicalProjectPath(projectPath);
  return { path: path.join(dir, MAIN_FILE), hash: hashMainCode(code) };
}

export interface MainWithHash {
  path: string;
  code: string;
  hash: string;
}

/** Relit `main.tsx` depuis le disque + hash. Throw si illisible (jamais de
 *  défaut silencieux : l'appelant remonte l'erreur, cf. bandeau + toast). */
export function readMainWithHash(projectPath: string): MainWithHash {
  const dir = canonicalProjectPath(projectPath);
  const main = path.join(dir, MAIN_FILE);
  let code: string;
  try {
    code = fs.readFileSync(main, "utf8");
  } catch (e) {
    throw new Error(`lecture main.tsx : ${e instanceof Error ? e.message : String(e)}`);
  }
  return { path: main, code, hash: hashMainCode(code) };
}

export interface RereadResult extends MainWithHash {
  /** Vrai si le disque diffère du hash connu → relecture nécessaire. */
  changed: boolean;
}

/** Relecture conditionnelle : compare le hash disque au hash connu
 *  (`null` = première lecture, toujours `changed:true`). Ne touche jamais à
 *  la mémoire — l'appelant décide (`setCode` si `changed`). */
export function rereadMainIfChanged(
  projectPath: string,
  knownHash: string | null,
): RereadResult {
  const got = readMainWithHash(projectPath);
  return { ...got, changed: knownHash === null || got.hash !== knownHash };
}
