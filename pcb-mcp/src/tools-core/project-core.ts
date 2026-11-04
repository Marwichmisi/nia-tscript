// Projets dossier : cœur pur (T1, #56) — aucune I/O, aucun import node:.
// Extrait de `src/project.ts` sans changer la logique. Les chemins passent
// par `PathLike` injecté (hôte sidecar : `node:path` — comportement inchangé
// sur chaque OS ; routeur agent : implémentation pure fournie ici) et les
// effets disque (`realpath`, `exists`, hash) par paramètres.
//
// Règle partagée (spec #37, ticket #38) : absolu, sans slash final, symlinks
// résolus quand le dossier existe. Le backend Rust applique la même règle
// (`canonical_project_path` dans `src-tauri/src/project.rs`).

/** Primitives chemins injectées (hôte : `node:path`, WebView : `posixPath`). */
export interface PathLike {
  sep: string;
  isAbsolute(p: string): boolean;
  normalize(p: string): string;
  dirname(p: string): string;
  basename(p: string): string;
  join(...parts: string[]): string;
}

function normalizePosix(p: string): string {
  const absolute = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    // `..` est refusé en amont (validate) : ici on le conserve tel quel
    // sans le résoudre (jamais atteint via `validateProjectPath`).
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) return "/" + joined;
  return joined || ".";
}

function dirnamePosix(p: string): string {
  if (p === "" || p === "/") return p === "/" ? "/" : ".";
  const stripped = p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
  const idx = stripped.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return stripped.slice(0, idx);
}

function basenamePosix(p: string): string {
  const stripped = p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
  const idx = stripped.lastIndexOf("/");
  return idx < 0 ? stripped : stripped.slice(idx + 1);
}

/** Implémentation pure (posix + absolus Windows acceptés), défaut WebView. */
export const posixPath: PathLike = {
  sep: "/",
  isAbsolute: (p: string) =>
    p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\"),
  normalize: normalizePosix,
  dirname: dirnamePosix,
  basename: basenamePosix,
  join: (...parts: string[]) => normalizePosix(parts.filter((s) => s !== "").join("/")),
};

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
export function validateProjectPath(input: string, pathLib: PathLike = posixPath): string {
  const raw = (input ?? "").trim();
  if (!raw) throw new Error("chemin projet vide");
  if (!pathLib.isAbsolute(raw)) throw new Error("chemin absolu requis");
  if (raw.split(/[/\\]/).includes("..")) throw new Error("traversal .. refusé");
  const normalized = pathLib.normalize(raw);
  const parts = normalized.split(pathLib.sep);
  if (parts.includes("..")) throw new Error("traversal .. refusé");
  return normalized;
}

function stripTrailingSep(normalized: string): string {
  let stripped = normalized;
  while (
    stripped.length > 1 &&
    (stripped.endsWith("/") || stripped.endsWith("\\")) &&
    !/^[A-Za-z]:[/\\]?$/.test(stripped)
  ) {
    stripped = stripped.slice(0, -1);
  }
  return stripped;
}

export interface CanonicalOptions {
  path?: PathLike;
  /** Résolution des symlinks (hôte : `fs.realpathSync`, agent : commande
   *  Tauri). Absent = pas de résolution (chemin normalisé seul). */
  realpath?: (p: string) => string;
}

/** Normalisation unique partagée (spec #37, ticket #38) : absolu, sans slash
 *  final, symlinks résolus quand le dossier existe. Le backend Rust applique
 *  la même règle (`canonical_project_path` dans `src-tauri/src/project.rs`).
 *  Toute entrée Registre/lockfile passe par ici (via `upsertRegistry`). */
export function canonicalProjectPath(input: string, opts?: CanonicalOptions): string {
  const normalized = validateProjectPath(input, opts?.path ?? posixPath);
  const stripped = stripTrailingSep(normalized);
  const realpath = opts?.realpath;
  if (!realpath) return stripped;
  try {
    return realpath(stripped);
  } catch {
    return stripped;
  }
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

export function upsertRegistry(
  reg: Registry,
  projectPath: string,
  now = new Date().toISOString(),
  canonicalize: (p: string) => string = (p) => canonicalProjectPath(p),
): Registry {
  const p = canonicalize(projectPath);
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
 *  `registry` explicite = sans I/O (tests) ; l'hôte charge le Registre disque. */
export function isProjectMember(
  input: string,
  registry: Registry,
  canonicalize: (p: string) => string = (p) => canonicalProjectPath(p),
): boolean {
  let canonical: string;
  try {
    canonical = canonicalize(input);
  } catch {
    return false;
  }
  return registry.projects.some((e) => {
    try {
      return canonicalize(e.path) === canonical;
    } catch {
      return e.path === canonical;
    }
  });
}

/** Variante qui throw une erreur explicite hors périmètre (jamais de
 *  `NO_PROJECT_OPEN` silencieux : le dossier existe peut-être, mais il
 *  n'est pas un Projet du Registre). Retourne le chemin canonique. */
export function assertProjectMember(
  input: string,
  registry: Registry,
  canonicalize: (p: string) => string = (p) => canonicalProjectPath(p),
): string {
  const canonical = canonicalize(input);
  if (isProjectMember(canonical, registry, canonicalize)) return canonical;
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
export function parentOfProjectPath(projectPath: string, pathLib: PathLike = posixPath): string {
  const dir = pathLib.dirname(projectPath);
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
 *  Ne touche jamais au disque (`exists` injecté par l'hôte). */
export function reconcileRegistry(reg: Registry, exists: (p: string) => boolean): ReconciledRegistry {
  const orphans = reg.projects.filter((e) => !exists(e.path)).map((e) => e.path);
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

/** Construit un chemin `<projet>/<fichier>` (hôte : `node:path.join`). */
export function projectMainPath(projectPath: string, pathLib: PathLike = posixPath): string {
  return pathLib.join(projectPath, MAIN_FILE);
}

export function projectCircuitPath(projectPath: string, pathLib: PathLike = posixPath): string {
  return pathLib.join(projectPath, CIRCUIT_FILE);
}

export function projectPreviewsDir(projectPath: string, pathLib: PathLike = posixPath): string {
  return pathLib.join(projectPath, PREVIEWS_DIR);
}

export function projectExportsDir(projectPath: string, pathLib: PathLike = posixPath): string {
  return pathLib.join(projectPath, EXPORTS_DIR);
}

/** Hash stable (sha256 hex, 64 car.) du contenu `main.tsx`.
 *  Même règle de hash que le backend Rust (`hash_main_content` dans
 *  `src-tauri/src/watch.rs`). Fonction de hash injectée (hôte : node:crypto). */
export function hashMainCode(code: string, sha256Hex: (s: string) => string): string {
  return sha256Hex(code);
}

/** Hash stable (sha256, 12 hex) du chemin canonique : clé d'exports qui
 *  distingue les homonymes (même basename, parents différents).
 *  Miroir documenté côté backend : même règle (sha256 du canonique). */
export function hashCanonicalPath(canonicalPath: string, sha256Hex: (s: string) => string): string {
  return sha256Hex(canonicalPath).slice(0, 12);
}

/** Payload d'événement `project-main-changed` : ce qui a changé + son hash.
 *  `path` = le `main.tsx` surveillé (pas le dossier), `hash` = son contenu. */
export interface MainChangedEvent {
  path: string;
  hash: string;
}

/** Construit le payload depuis le dossier Projet canonique + code disque.
 *  Hash injecté par l'hôte (pas de défaut silencieux : sans hash, throw). */
export function buildMainChangedEvent(
  projectPath: string,
  code: string,
  opts: { canonicalize?: (p: string) => string; hash: (s: string) => string; path?: PathLike },
): MainChangedEvent {
  if (!opts?.hash) throw new Error("buildMainChangedEvent : fonction de hash requise (injectée par l'hôte)");
  const canonicalize = opts.canonicalize ?? ((p: string) => canonicalProjectPath(p));
  const dir = canonicalize(projectPath);
  return {
    path: (opts.path ?? posixPath).join(dir, MAIN_FILE),
    hash: hashMainCode(code, opts.hash),
  };
}

export interface MainWithHash {
  path: string;
  code: string;
  hash: string;
}

export interface RereadResult extends MainWithHash {
  /** Vrai si le disque diffère du hash connu → relecture nécessaire. */
  changed: boolean;
}

/** Relecture conditionnelle pure : compare le hash disque au hash connu
 *  (`null` = première lecture, toujours `changed:true`). Ne touche jamais à
 *  la mémoire — l'appelant décide (`setCode` si `changed`). */
export function rereadMainIfChanged(
  got: MainWithHash,
  knownHash: string | null,
): RereadResult {
  return { ...got, changed: knownHash === null || got.hash !== knownHash };
}
