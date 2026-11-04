// Effets injectés du cœur (T1, #56) : tout ce qui touche disque/réseau/env
// ou à la résolution du Projet est un paramètre. Le cœur n'importe aucun
// `node:`, ne lit ni lockfile ni env. L'hôte sidecar (`src/deps.ts`) fournit
// les implémentations Bun ; le routeur agent fournira les siennes (Tauri +
// WebWorker). Aucune logique métier ici, que des types.
import type { CheckDomain, PlacementGate, PositionedViolation } from "./checks.js";
import type { CompileFn } from "./diagnostics.js";
import type { FetchFn } from "./sourcing.js";
import type { PreviewReader } from "./preview.js";
import type {
  ProjectListItem,
  Registry,
} from "./project-core.js";
import type { LogEntry, MemoryStore } from "./store.js";

/** Persistance Projet (hôte : `persistProjectFiles` atomique ; throw si KO). */
export type PersistFn = (projectPath: string, code: string, circuitJson: unknown[]) => void;

/** Journal (hôte : store mémoire partagé). */
export type LogFn = (
  level: LogEntry["level"],
  source: LogEntry["source"],
  message: string,
) => void;

/** I/O Projets (hôte : Registre/lockfile/layout sur disque). */
export interface ProjectIo {
  canonicalize: (p: string) => string;
  ensureLayout: (dir: string, template: string) => "created" | "exists";
  ensureCircuitFile: (dir: string) => "created" | "migrated" | "exists";
  dirExists: (dir: string) => boolean;
  mainExists: (dir: string) => boolean;
  readMain: (projectPath: string) => string | null;
  loadRegistry: () => Registry;
  saveRegistry: (reg: Registry) => void;
  writeLock: (projectPath: string | null) => void;
  listProjects: () => { projects: ProjectListItem[]; lastOpened: string | null };
}

/** I/O exports fab (hôte : `<projet>/exports/<basename>-<hash12>` sur disque). */
export interface FabIo {
  projectNameForExport: (projectPath: string, explicitName: string | undefined) => string;
  resolveExportDir: (projectPath: string, projectName: string, sessionId: string) => string;
  mkdirp: (dir: string) => void;
  writeFile: (filePath: string, content: string | Buffer) => void;
  joinPath: (...parts: string[]) => string;
  toFileUrl: (filePath: string) => string;
}

/** Lecture captures (hôte : `<Projet>/previews/` + repli override de tests). */
export interface PreviewIo {
  previewDirFor: (projectPath: string | null) => string;
  previewFallbackDir: () => string;
  readPreview: PreviewReader;
}

/** Contrôles natifs (défaut : cœur `@tscircuit/checks` ; substituable). */
export interface ChecksIo {
  runPlacementGate: (circuitJson: unknown[], tsx: string) => Promise<PlacementGate>;
  runDomainChecks: (circuitJson: unknown[], domain: CheckDomain) => Promise<PositionedViolation[]>;
}

export interface ToolsDeps {
  /** Mémoire partagée (hôte : singleton du store ; jamais de résolution Projet). */
  store: MemoryStore;
  /** Projet ouvert résolu par l'hôte (lockfile côté sidecar, BootState côté app). */
  resolveProject: () => string | null;
  /** Confinement (hôte : Registre disque après canonicalisation ; throw hors périmètre, retourne le canonique). */
  assertMember: (projectPath: string) => string;
  /** Nom de board isolé au Projet (hôte : basename du Projet ouvert). */
  boardName: () => string;
  /** Compile injectée (sidecar : `compileTsx` Bun ; app : WebWorker). */
  compile: CompileFn;
  /** Persistance injectée (atomique des deux côtés, jamais d'applied:true sur KO). */
  persist: PersistFn;
  /** Fetch injecté (sourcing JLCPCB-first ; refus offline-first sans réseau). */
  fetchFn: FetchFn;
  /** Contrôles (optionnel : défaut cœur pur). */
  checks?: ChecksIo;
  log: LogFn;
  io: ProjectIo;
  fab: FabIo;
  preview: PreviewIo;
}
