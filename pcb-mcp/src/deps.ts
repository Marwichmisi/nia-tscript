// Câblage hôte sidecar (T1, #56) : construit les `ToolsDeps` du cœur avec
// les effets Bun (compile `CircuitRunner`, persistance atomique, lockfile +
// Registre, fetch global, journal mémoire). Le routeur agent fournira son
// propre câblage (WebWorker + commandes Tauri) sur le même cœur.
// Aucune logique métier ici : que du branchement.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileTsx } from "./compile.js";
import {
  assertProjectMember,
  canonicalProjectPath,
  currentProjectPath,
  ensureCircuitFile,
  ensureProjectLayout,
  listProjects,
  loadRegistry,
  persistProjectFiles,
  projectExportDir,
  projectMainPath,
  projectPreviewsDir,
  saveRegistry,
  writeLockProjectPath,
} from "./project.js";
import { readPreview } from "./preview.js";
import { appendLog, getSharedStore, projectBoardName } from "./state.js";
import { sanitizeSegment } from "./tools-core/fab.js";
import type { ToolsDeps } from "./tools-core/deps.js";

function loadCodeForProject(projectPath: string): void {
  try {
    const code = fs.readFileSync(projectMainPath(projectPath), "utf8");
    if (code.trim()) getSharedStore().setCode(code);
  } catch {
    // layout garantit main.tsx ; best-effort.
  }
}

/** Charge le TSX disque en mémoire au boot sidecar (ticket #43) : le
 *  disque est la source unique de vérité, la mémoire n'est qu'un cache
 *  invalidé au démarrage. Ne throw jamais (boot best-effort, loggé via
 *  l'appelant) ; retourne vrai si un Projet est ouvert (rechargé ou déjà
 *  en phase), faux si Accueil (rien à recharger). */
export function loadOpenProjectCode(): boolean {
  const proj = currentProjectPath();
  if (!proj) return false;
  loadCodeForProject(proj);
  return true;
}

function persistCurrent(projectPath: string, code: string, circuitJson: unknown[]): void {
  try {
    persistProjectFiles(projectPath, code, circuitJson);
  } catch (e) {
    // Écriture non silencieuse (ticket #43) : jamais de `applied:true` sur
    // disque KO — l'appelant répond `applied:false` avec ce message.
    throw new Error(
      `persistance disque impossible (main.tsx) : ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function readMain(projectPath: string): string | null {
  try {
    return fs.readFileSync(projectMainPath(projectPath), "utf8");
  } catch {
    // layout garantit main.tsx ; best-effort (cf. loadCodeForProject).
    return null;
  }
}

/** Deps sidecar : compile Bun + persistance atomique + lockfile/Registre. */
export function getToolsDeps(): ToolsDeps {
  return {
    store: getSharedStore(),
    resolveProject: currentProjectPath,
    assertMember: (p) => assertProjectMember(p),
    boardName: projectBoardName,
    compile: (code, opts) => compileTsx(code, opts),
    persist: persistCurrent,
    fetchFn: fetch,
    // checks : défaut cœur (@tscircuit/checks) — substituable.
    log: (level, source, message) => {
      appendLog(level, source, message);
    },
    io: {
      canonicalize: canonicalProjectPath,
      ensureLayout: ensureProjectLayout,
      ensureCircuitFile,
      dirExists: (d) => fs.existsSync(d),
      mainExists: (d) => fs.existsSync(projectMainPath(d)),
      readMain,
      loadRegistry,
      saveRegistry,
      writeLock: writeLockProjectPath,
      listProjects,
    },
    fab: {
      // `PCB_MCP_EXPORT_DIR` est un hook de TEST (revue #37 item 4) :
      // jamais posé par le backend prod, non contrôlable via MCP.
      projectNameForExport: (projectPath, explicitName) =>
        (process.env.PCB_MCP_EXPORT_DIR ?? "").trim()
          ? (explicitName ?? path.basename(projectPath))
          : path.basename(projectPath),
      // Override tests PCB_MCP_EXPORT_DIR prioritaire (suites historiques),
      // sinon <projet>/exports/<basename>-<hash12(canonique)> (homonymes distingués).
      resolveExportDir: (projectPath, projectName, sessionId) => {
        const exportOverride = (process.env.PCB_MCP_EXPORT_DIR ?? "").trim();
        return exportOverride
          ? path.join(exportOverride, sanitizeSegment(sessionId), sanitizeSegment(projectName))
          : projectExportDir(canonicalProjectPath(projectPath));
      },
      mkdirp: (d) => fs.mkdirSync(d, { recursive: true }),
      writeFile: (p, content) => fs.writeFileSync(p, content),
      joinPath: (...parts) => path.join(...parts),
      toFileUrl: (p) => pathToFileURL(p).href,
    },
    preview: {
      previewDirFor: (proj) => (proj ? projectPreviewsDir(proj) : ""),
      previewFallbackDir: () => (process.env.PCB_MCP_PREVIEW_DIR ?? "").trim(),
      readPreview: (sourceInput, opts) => readPreview(sourceInput, opts),
    },
  };
}
