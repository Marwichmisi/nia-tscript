// Fabrique MCP (SDK TS v2 brut, pas mcp-use — findings §5 / spec #8).
// Une seule factory pour les deux eras : moderne 2026-07-28 + fallback
// legacy initialize stateless (createMcpHandler défaut `legacy: 'stateless'`).
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { boardExpectsRouting, boardRoutingDisabled, emptyStats, isBoardRouted, ROUTE_EFFORTS } from "./board.js";
import { runDomainChecks, runPlacementGate, type CheckDomain } from "./checks.js";
import { compileTsx } from "./compile.js";
import { applyBatch, BATCH_MAX_OPS, type BatchOp } from "./batch.js";
import { exportFab, fabExportBaseDir, sanitizeSegment, writeFabArtifacts, type FabOk } from "./fab.js";
import {
  applyMove,
  applyReassignNet,
  applyRotate,
  applySwapPackage,
  getSelection,
  listViews,
  refuseLiveCreation,
  REFUSED_LIVE_OPS,
} from "./live.js";
import { applyAnchoredPatch } from "./patch.js";
import { readPreview } from "./preview.js";
import { enqueue } from "./queue.js";
import { searchParts } from "./sourcing.js";
import {
  appendLog,
  getBoardState,
  getCode,
  getHierarchy,
  readLogs,
  restoreStore,
  setCode,
  setDrcViolations,
  setLastCompile,
  snapshotStore,
} from "./state.js";
import {
  NO_PROJECT_OPEN,
  OUT_OF_SCOPE,
  assertProjectMember,
  canonicalProjectPath,
  currentProjectPath,
  ensureCircuitFile,
  ensureProjectLayout,
  listProjects,
  loadRegistry,
  persistProjectFiles,
  projectCircuitPath,
  projectExportDir,
  projectMainPath,
  projectPreviewsDir,
  saveRegistry,
  upsertRegistry,
  writeLockProjectPath,
} from "./project.js";

export const SERVER_NAME = "pcb-mcp";
export const SERVER_VERSION = "0.1.0";

const PcbStateInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
});

const PcbStateOutput = z.object({
  sessionId: z.string(),
  board: z.string(),
  ready: z.boolean(),
  compile: z.object({ status: z.string(), errors: z.number(), warnings: z.number() }),
  drc: z.object({ violations: z.number() }),
  protocolVersion: z.string(),
});

const LogsReadInput = z.object({
  cursor: z.string().optional().describe("Seq de reprise (exclue)"),
  limit: z.number().int().min(1).max(100).optional().describe("1..100, défaut 20"),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
});

const LogsReadOutput = z.object({
  entries: z.array(
    z.object({
      seq: z.number(),
      ts: z.string(),
      level: z.string(),
      source: z.string(),
      message: z.string(),
    }),
  ),
  nextCursor: z.string(),
  hasMore: z.boolean(),
  newErrors: z.number(),
});

// --- Projets (Q4/Q11/Q15) : seuls outils accessibles sans Projet ouvert.
const ProjectListOutput = z.object({
  projects: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      parent: z.string().describe("Dossier parent complet (homonymes distingués)"),
      exists: z.boolean(),
      lastOpened: z.string(),
    }),
  ),
  lastOpened: z.string().nullable(),
  current: z.string().nullable(),
});

const ProjectCreateInput = z.object({
  path: z.string().describe("Chemin dossier absolu, créé si absent"),
  template: z.enum(["vide", "demo"]).optional().describe("Contenu initial (défaut: vide)"),
});

const ProjectOpenInput = z.object({
  path: z.string().describe("Chemin dossier absolu contenant main.tsx"),
});

function noProjectError(code: string): { message: string; code: string } {
  return {
    message: `aucun projet ouvert : ouvre un projet dans l'app ou via project_open (${code})`,
    code: NO_PROJECT_OPEN,
  };
}

/** Jail Confinement (ticket #42) : le Projet courant (lockfile) doit être
 *  membre du Registre après canonicalisation. Retourne `null` si le jail
 *  passe, sinon l'erreur explicite hors périmètre (à fusionner dans la
 *  sortie de refus de l'outil, comme `noProjectError`).
 *  `null` projet → `null` aussi (l'appelant garde son `NO_PROJECT_OPEN`). */
function checkConfined(tool: string, proj: string | null): { message: string; code: string } | null {
  if (!proj) return null;
  try {
    assertProjectMember(proj);
    return null;
  } catch (e) {
    return { message: `${(e as Error).message} (${tool})`, code: OUT_OF_SCOPE };
  }
}

function loadCodeForProject(projectPath: string): void {
  try {
    const code = fs.readFileSync(projectMainPath(projectPath), "utf8");
    if (code.trim()) setCode(code);
  } catch {
    // layout garantit main.tsx ; best-effort.
  }
}

/** Recharge le TSX disque en mémoire au boot sidecar (ticket #43) : le
 *  disque est la source unique de vérité, la mémoire n'est qu'un cache
 *  invalidé au démarrage. Ne throw jamais (boot best-effort, loggé via
 *  l'appelant) ; retourne vrai si un Projet est ouvert (rechargé ou déjà
 *  en phase), faux si Accueil (rien à recharger). */
export function reloadOpenProjectFromDisk(): boolean {
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

const CodePatchInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  anchor: z.string().min(1).describe("Extrait exact du TSX, exactement une occurrence"),
  replacement: z.string().describe("Texte de remplacement de l'ancre"),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

const CodePatchOutput = z.object({
  sessionId: z.string(),
  applied: z.boolean(),
  ready: z.boolean(),
  stats: z.object({
    total: z.number(),
    components: z.number(),
    traces: z.number(),
    nets: z.number(),
    byType: z.record(z.string(), z.number()),
  }),
  diagnostics: z.array(
    z.object({ severity: z.string(), message: z.string(), source: z.string() }),
  ),
  mode: z.string(),
  banner: z.string().nullable(),
  errors: z.number(),
  warnings: z.number(),
  circuitJsonLength: z.number(),
  circuitJson: z.array(z.any()),
});

const RunChecksInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  domain: z
    .enum(["netlist", "placement", "routing", "style", "all"])
    .optional()
    .describe("Domaine natif (défaut: all) ; routing refusé si placement non vert"),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

const ViolationOutput = z.object({
  domain: z.string(),
  type: z.string(),
  message: z.string(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  refdes: z.string().nullable(),
});

const RunChecksOutput = z.object({
  sessionId: z.string(),
  domain: z.string(),
  placementGreen: z.boolean(),
  routingAllowed: z.boolean(),
  blockReason: z.string().nullable(),
  counts: z.object({
    netlist: z.number(),
    placement: z.number(),
    routing: z.number(),
    style: z.number(),
    total: z.number(),
  }),
  violations: z.array(ViolationOutput),
  errors: z.number(),
  warnings: z.number(),
});

const LiveManageInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  op: z.string().describe("move | rotate | swap_package | reassign_net | select | view"),
  refdes: z.string().optional().describe("Composant visé (ex R1)"),
  x: z.number().optional().describe("move : pcbX en mm"),
  y: z.number().optional().describe("move : pcbY en mm"),
  degrees: z.number().optional().describe("rotate : pcbRotation en degrés"),
  footprint: z.string().optional().describe("swap_package : empreinte cible (ex 0603)"),
  pin: z.string().optional().describe("reassign_net : pin visée (ex pin1)"),
  net: z.string().optional().describe("reassign_net : net cible (ex GND ou net.GND)"),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

const LiveManageOutput = z.object({
  sessionId: z.string(),
  op: z.string(),
  applied: z.boolean(),
  ready: z.boolean(),
  stats: z.object({
    total: z.number(),
    components: z.number(),
    traces: z.number(),
    nets: z.number(),
    byType: z.record(z.string(), z.number()),
  }),
  diagnostics: z.array(
    z.object({ severity: z.string(), message: z.string(), source: z.string() }),
  ),
  mode: z.string(),
  banner: z.string().nullable(),
  errors: z.number(),
  warnings: z.number(),
  circuitJsonLength: z.number(),
  circuitJson: z.array(z.any()),
  code: z.string().nullable(),
  selection: z
    .object({
      refdes: z.string(),
      pkg: z.string(),
      value: z.string(),
      rotation: z.number(),
      nets: z.array(z.string()),
    })
    .nullable(),
  views: z.array(z.string()).nullable(),
  message: z.string().nullable(),
});

const PreviewScreenshotInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  source: z
    .string()
    .describe("schematic_2d | pcb_2d | pcb_3d (alias prototype schematique_2d accepté)"),
  name: z
    .string()
    .optional()
    .describe("Capture nommée (slug a-z0-9-_, max 32, défaut: dernier de la source)"),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

const PreviewScreenshotOutput = z.object({
  sessionId: z.string(),
  source: z.string(),
  name: z.string().nullable(),
  found: z.boolean(),
  dataUrl: z.string().nullable(),
  bytes: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  previewUrl: z.string().nullable(),
  updatedAt: z.string().nullable(),
  banner: z.string().nullable(),
  message: z.string().nullable(),
  errors: z.number(),
  warnings: z.number(),
});

const BatchOpSchema = z.union([
  z.object({
    kind: z.literal("patch"),
    anchor: z.string().min(1).describe("Extrait exact du TSX, exactement une occurrence"),
    replacement: z.string().describe("Texte de remplacement de l'ancre"),
  }),
  z.object({
    kind: z.literal("move"),
    refdes: z.string().min(1).describe("Composant visé (ex R1)"),
    x: z.number().describe("move : pcbX en mm"),
    y: z.number().describe("move : pcbY en mm"),
  }),
  z.object({
    kind: z.literal("rotate"),
    refdes: z.string().min(1).describe("Composant visé (ex R1)"),
    degrees: z.number().describe("rotate : pcbRotation en degrés"),
  }),
  z.object({
    kind: z.literal("swap_package"),
    refdes: z.string().min(1).describe("Composant visé (ex R1)"),
    footprint: z.string().min(1).describe("swap_package : empreinte cible (ex 0603)"),
  }),
  z.object({
    kind: z.literal("reassign_net"),
    refdes: z.string().min(1).describe("Composant visé (ex R1)"),
    pin: z.string().min(1).describe("reassign_net : pin visée (ex pin1)"),
    net: z.string().min(1).describe("reassign_net : net cible (ex GND ou net.GND)"),
  }),
  z.object({
    kind: z.literal("route"),
    effort: z
      .enum(ROUTE_EFFORTS)
      .optional()
      .describe("route : effort de l'autorouteur local auto_local (défaut 1x)"),
  }),
]);

const BatchExecuteInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  operations: z
    .array(BatchOpSchema)
    .describe(
      `Lot atomique patch+live+route (1..${BATCH_MAX_OPS}) : une seule approbation couvre l'itération complète, rollback si un op échoue`,
    ),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

const BatchExecuteOutput = z.object({
  sessionId: z.string(),
  applied: z.boolean(),
  ready: z.boolean(),
  failedOpIndex: z.number().nullable(),
  rolledBack: z.boolean(),
  stats: z.object({
    total: z.number(),
    components: z.number(),
    traces: z.number(),
    nets: z.number(),
    byType: z.record(z.string(), z.number()),
  }),
  diagnostics: z.array(
    z.object({ severity: z.string(), message: z.string(), source: z.string() }),
  ),
  mode: z.string(),
  banner: z.string().nullable(),
  errors: z.number(),
  warnings: z.number(),
  circuitJsonLength: z.number(),
  circuitJson: z.array(z.any()),
  code: z.string().nullable(),
});

const SearchPartsInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  query: z.string().describe("Nom, valeur ou réf LCSC (ex 10k, 0402, C21190, RP2040)"),
  source: z
    .string()
    .optional()
    .describe("Source catalogue (défaut: jlcpcb ; alias lcsc ; digikey/mouser → V2)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("1..10, défaut 5"),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

const SearchPartsOutput = z.object({
  sessionId: z.string(),
  query: z.string(),
  source: z.string(),
  tsciSearch: z.string(),
  results: z.array(
    z.object({
      lcsc: z.string(),
      mfr: z.string(),
      package: z.string(),
      description: z.string(),
      stock: z.number().nullable(),
      footprint: z.string(),
      footprinterString: z.string().nullable(),
      footprintSource: z.string(),
      tsxSnippet: z.string(),
      tsciImport: z.string(),
    }),
  ),
  banner: z.string().nullable(),
  message: z.string().nullable(),
  errors: z.number(),
  warnings: z.number(),
});

const FabExportInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  project_name: z
    .string()
    .optional()
    .describe("Nom projet pour les fichiers KiCad (défaut: basename du Projet ouvert)"),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

const FabExportOutput = z.object({
  sessionId: z.string(),
  ready: z.boolean(),
  mode: z.string(),
  banner: z.string().nullable(),
  errors: z.number(),
  warnings: z.number(),
  counts: z.object({
    gerberFiles: z.number(),
    bomRows: z.number(),
    pnpRows: z.number(),
  }),
  gerberNames: z.array(z.string()),
  gerberPreview: z.string(),
  bomCsv: z.string(),
  pnpCsv: z.string(),
  kicad: z.object({
    pcbBytes: z.number(),
    schBytes: z.number(),
    proBytes: z.number(),
    pcbPreview: z.string(),
  }),
  kicadZip: z.object({ bytes: z.number(), previewUrl: z.string() }),
  fabZip: z.object({ bytes: z.number(), previewUrl: z.string() }),
  artifacts: z.array(
    z.object({ name: z.string(), bytes: z.number(), previewUrl: z.string() }),
  ),
  exportDir: z.string(),
  message: z.string().nullable(),
});

export function buildFactory() {
  return () => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } },
    );

    server.registerTool(
      "project_list",
      {
        title: "Lister les projets",
        description: "Liste les Projets du Registre avec existence disque. Accessible sans Projet ouvert.",
        inputSchema: z.object({}),
        outputSchema: ProjectListOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async () => {
        const { projects, lastOpened } = listProjects();
        const output = { projects, lastOpened, current: currentProjectPath() };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "project_current",
      {
        title: "Projet courant",
        description: "Retourne le Projet ouvert ou null si Accueil. Accessible sans Projet ouvert.",
        inputSchema: z.object({}),
        outputSchema: z.object({ current: z.string().nullable() }),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async () => {
        const output = { current: currentProjectPath() };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "project_create",
      {
        title: "Créer un projet",
        description: "Crée le dossier Projet (auto-création) avec gabarit vide|demo, l'ouvre et charge son TSX. Refuse dossier non-vide sans main.tsx.",
        inputSchema: ProjectCreateInput,
        outputSchema: z.object({
          path: z.string(),
          created: z.boolean(),
          current: z.string().nullable(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ path: p, template }) => {
        return enqueue(async () => {
          // Frontière outil : normalisation canonique unique (sans slash,
          // symlinks résolus si existe) — même règle que le backend Rust.
          const dir = canonicalProjectPath(p);
          const outcome = ensureProjectLayout(dir, template ?? "vide");
          const reg = loadRegistry();
          const next = upsertRegistry(reg, dir);
          saveRegistry(next);
          writeLockProjectPath(dir);
          loadCodeForProject(dir);
          appendLog("info", "server", `project_create ${dir} (${outcome})`);
          const output = { path: dir, created: outcome === "created", current: currentProjectPath() };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        });
      },
    );

    server.registerTool(
      "project_open",
      {
        title: "Ouvrir un projet",
        description: "Ouvre un Projet existant (main.tsx requis), le marque lastOpened et charge son TSX.",
        inputSchema: ProjectOpenInput,
        outputSchema: z.object({
          path: z.string(),
          current: z.string().nullable(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ path: p }) => {
        return enqueue(async () => {
          const dir = canonicalProjectPath(p);
          if (!fs.existsSync(dir)) throw new Error("dossier introuvable");
          if (!fs.existsSync(projectMainPath(dir))) {
            throw new Error("dossier sans main.tsx : refuse d'ouvrir");
          }
          // Disque source de vérité : circuit.json recréé si absent, migré
          // si legacy, erreur visible si corrompu (ticket #38).
          ensureCircuitFile(dir);
          const reg = loadRegistry();
          const next = upsertRegistry(reg, dir);
          saveRegistry(next);
          writeLockProjectPath(dir);
          loadCodeForProject(dir);
          appendLog("info", "server", `project_open ${dir}`);
          const output = { path: dir, current: currentProjectPath() };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        });
      },
    );

    server.registerTool(
      "project_close",
      {
        title: "Fermer le projet",
        description: "Ramène à l'Accueil et reverrouille le MCP (project_* seuls).",
        inputSchema: z.object({}),
        outputSchema: z.object({ current: z.string().nullable() }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async () => {
        return enqueue(async () => {
          writeLockProjectPath(null);
          appendLog("info", "server", "project_close → Accueil");
          const output = { current: currentProjectPath() };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        });
      },
    );

    server.registerTool(
      "pcb_state",
      {
        title: "État lecture du studio",
        description: "Lit l'état du studio (board ouverte, readiness, compile/DRC). Lecture seule.",
        inputSchema: PcbStateInput,
        outputSchema: PcbStateOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ session_id }) => {
        const proj = currentProjectPath();
        if (!proj) {
          const err = noProjectError("pcb_state");
          const output = {
            sessionId: session_id ?? "default",
            board: "",
            ready: false,
            compile: { status: "error", errors: 1, warnings: 0 },
            drc: { violations: 0 },
            protocolVersion: getBoardState(session_id ?? "default").protocolVersion,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
            structuredContent: output,
          };
        }
        const output = getBoardState(session_id ?? "default");
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "logs_read",
      {
        title: "Lecture des logs",
        description: "Lit les logs compilateur/ERC/DRC/export avec curseur et signalement des nouvelles erreurs.",
        inputSchema: LogsReadInput,
        outputSchema: LogsReadOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ cursor, limit, level }) => {
        if (!currentProjectPath()) {
          const err = noProjectError("logs_read");
          const output = { entries: [], nextCursor: "", hasMore: false, newErrors: 1 };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
            structuredContent: output,
          };
        }
        const output = readLogs({ cursor, limit, level });
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerResource(
      "hierarchy",
      "pcb://hierarchy",
      {
        title: "Hiérarchie du circuit",
        description: "Hiérarchie board → modules → composants → pins (miroir lecture).",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              currentProjectPath() ? getHierarchy() : { error: NO_PROJECT_OPEN },
            ),
          },
        ],
      }),
    );

    server.registerTool(
      "code_patch",
      {
        title: "Patch TSX ancré + diagnostics",
        description:
          "Applique un patch TSX ancré (une occurrence exacte) puis compile (core+eval offline-first) : retourne circuit-json, diagnostics compilateur et stats.",
        inputSchema: CodePatchInput,
        outputSchema: CodePatchOutput,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ session_id, anchor, replacement, disableCdnLoading }) => {
        return enqueue(async () => {
          const sessionId = session_id ?? "default";
          const proj = currentProjectPath();
          // Jail Confinement (#42) : écriture refusée hors Registre.
          const scopeErr = checkConfined("code_patch", proj);
          if (!proj || scopeErr) {
            const err = scopeErr ?? noProjectError("code_patch");
            const output = {
              sessionId,
              applied: false as const,
              ready: false,
              stats: emptyStats(),
              diagnostics: [{ severity: "error", message: err.message, source: "code_patch" }],
              mode: "refuse",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
            };
            return {
              content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
              structuredContent: output,
            };
          }
          const patched = applyAnchoredPatch(getCode(), anchor, replacement);
          if (!patched.ok) {
            const output = {
              sessionId,
              applied: false as const,
              ready: getBoardState(sessionId).ready,
              stats: emptyStats(),
              diagnostics: [
                { severity: "error", message: patched.message, source: "code_patch" },
              ],
              mode: "echec",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
            };
            appendLog("error", "compile", `code_patch rejeté : ${patched.message}`);
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          const compiled = await compileTsx(patched.code, { disableCdnLoading });
          setLastCompile({
            status: compiled.errors === 0 ? "ok" : "error",
            errors: compiled.errors,
            warnings: compiled.warnings,
          });
          if (compiled.errors === 0) {
            try {
              // `setCode` suit la persistance réussie : sur disque KO la
              // mémoire reste égale au disque (source de vérité).
              persistCurrent(proj, patched.code, compiled.circuitJson);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              appendLog("error", "compile", `code_patch disque KO : ${message}`);
              const output = {
                sessionId,
                applied: false as const,
                ready: false,
                stats: compiled.stats,
                diagnostics: [{ severity: "error", message, source: "code_patch" }],
                mode: "echec",
                banner: compiled.banner,
                errors: 1,
                warnings: compiled.warnings,
                circuitJsonLength: 0,
                circuitJson: [] as unknown[],
              };
              return {
                content: [{ type: "text", text: JSON.stringify(output) }],
                structuredContent: output,
              };
            }
            setCode(patched.code);
            appendLog(
              "info",
              "compile",
              `code_patch ok : ${compiled.stats.total} éléments, 0 erreur`,
            );
          } else {
            setCode(patched.code);
            appendLog(
              "error",
              "compile",
              `code_patch compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
            );
          }
          const output = {
            sessionId,
            applied: true as const,
            ready: compiled.errors === 0,
            stats: compiled.stats,
            diagnostics: compiled.diagnostics,
            mode: compiled.mode,
            banner: compiled.banner,
            errors: compiled.errors,
            warnings: compiled.warnings,
            circuitJsonLength: compiled.circuitJson.length,
            circuitJson: compiled.circuitJson,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        });
      },
    );

    server.registerTool(
      "run_checks",
      {
        title: "Contrôles natifs + gate placement",
        description:
          "Lance les contrôles natifs tscircuit (netlist, placement, routing, style PCB) sur le TSX courant et retourne les violations positionnées. Gate dur : le domaine routing est refusé tant que le placement n'est pas vert (coordonnées pcbX/pcbY explicites exigées).",
        inputSchema: RunChecksInput,
        outputSchema: RunChecksOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ session_id, domain, disableCdnLoading }) => {
        const proj0 = currentProjectPath();
        if (!proj0) {
          const err = noProjectError("run_checks");
          const output = {
            sessionId: session_id ?? "default",
            domain: domain ?? "all",
            placementGreen: false,
            routingAllowed: false,
            blockReason: err.message,
            counts: { netlist: 0, placement: 0, routing: 0, style: 0, total: 0 },
            violations: [],
            errors: 1,
            warnings: 0,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
            structuredContent: output,
          };
        }
        const sessionId = session_id ?? "default";
        const asked: CheckDomain = domain ?? "all";
        const code = getCode();
        const compiled = await compileTsx(code, { disableCdnLoading });
        // Runner en échec (exception) → pas de circuit-json exploitable.
        // Les erreurs embarquées (soft) n'empêchent pas le gate (#39 : gate
        // placement inchangé, évalué sur le circuit-json réel).
        if (compiled.mode === "echec") {
          const output = {
            sessionId,
            domain: asked,
            placementGreen: false,
            routingAllowed: false,
            blockReason: `compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"} — corrigez via code_patch avant tout check`,
            counts: { netlist: 0, placement: 0, routing: 0, style: 0, total: 0 },
            violations: [],
            errors: 1,
            warnings: 0,
          };
          appendLog("error", "drc", `run_checks ${asked} impossible : compile en erreur`);
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        const gate = await runPlacementGate(compiled.circuitJson, code);
        // Gate dur : aucun routing tant que le placement n'est pas vert.
        if (asked === "routing" && !gate.routingAllowed) {
          const output = {
            sessionId,
            domain: asked,
            placementGreen: gate.placementGreen,
            routingAllowed: false,
            blockReason: gate.blockReason,
            counts: {
              netlist: 0,
              placement: gate.placementViolations.length,
              routing: 0,
              style: 0,
              total: gate.placementViolations.length,
            },
            violations: gate.placementViolations,
            errors: 1,
            warnings: 0,
          };
          setDrcViolations(gate.placementViolations.length);
          appendLog("error", "drc", `run_checks routing refusé : ${gate.blockReason ?? "placement non vert"}`);
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        let violations = await runDomainChecks(compiled.circuitJson, asked);
        // Gate dur (#39) : domain=all ne fournit plus de routage quand le
        // routage est interdit (placement non vert). Gate placement inchangé.
        if (asked === "all" && !gate.routingAllowed) {
          violations = violations.filter((v) => v.domain !== "routing");
        }
        const counts = {
          netlist: violations.filter((v) => v.domain === "netlist").length,
          placement: violations.filter((v) => v.domain === "placement").length,
          routing: violations.filter((v) => v.domain === "routing").length,
          style: violations.filter((v) => v.domain === "style").length,
          total: violations.length,
        };
        setDrcViolations(counts.total);
        appendLog(
          violations.length === 0 ? "info" : "warn",
          "drc",
          `run_checks ${asked} : ${violations.length} violation(s), placement ${gate.placementGreen ? "vert" : "rouge"}`,
        );
        const output = {
          sessionId,
          domain: asked,
          placementGreen: gate.placementGreen,
          routingAllowed: gate.routingAllowed,
          blockReason: gate.blockReason,
          counts,
          violations,
          // Compteurs réels (#39) : erreurs/warnings embarqués du circuit-json.
          errors: compiled.errors,
          warnings: compiled.warnings,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "live_manage",
      {
        title: "Live-mutation restreinte write-through",
        description:
          "Mutation live restreinte (move | rotate | swap_package | reassign_net + select/view) : réécrit le TSX aussitôt puis recompile, readiness stampée. Création/suppression refusées vers code_patch. Écritures sérialisées par la file.",
        inputSchema: LiveManageInput,
        outputSchema: LiveManageOutput,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ session_id, op, refdes, x, y, degrees, footprint, pin, net, disableCdnLoading }) => {
        const projLive = currentProjectPath();
        // Jail Confinement (#42) : lecture/écriture refusées hors Registre.
        const scopeErrLive = checkConfined("live_manage", projLive);
        if (!projLive || scopeErrLive) {
          const err = scopeErrLive ?? noProjectError("live_manage");
          const output = {
            sessionId: session_id ?? "default",
            op: (op ?? "").trim(),
            applied: false as const,
            ready: false,
            stats: emptyStats(),
            diagnostics: [{ severity: "error", message: err.message, source: "live_manage" }],
            mode: "refuse",
            banner: null as string | null,
            errors: 1,
            warnings: 0,
            circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: null as string | null,
            selection: null,
            views: null as string[] | null,
            message: err.message,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
            structuredContent: output,
          };
        }
        const sessionId = session_id ?? "default";
        const asked = (op ?? "").trim();

        const refused = (REFUSED_LIVE_OPS as readonly string[]).includes(asked);
        if (refused || asked === "create") {
          const message = refuseLiveCreation(asked || "create");
          const ready = getBoardState(sessionId).ready;
          const output = {
            sessionId,
            op: asked,
            applied: false as const,
            ready,
            stats: emptyStats(),
            diagnostics: [{ severity: "error", message, source: "live_manage" }],
            mode: "refuse",
            banner: null as string | null,
            errors: 1,
            warnings: 0,
            circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: null as string | null,
            selection: null,
            views: null as string[] | null,
            message,
          };
          appendLog("error", "compile", `live_manage ${asked} refusé : ${message}`);
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }

        if (asked === "select") {
          if (!refdes) {
            const message = "select exige refdes (ex R1)";
            const ready = getBoardState(sessionId).ready;
            const output = {
              sessionId,
              op: asked,
              applied: false as const,
              ready,
              stats: emptyStats(),
              diagnostics: [{ severity: "error", message, source: "live_manage" }],
              mode: "refuse",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: getCode(),
              selection: null,
              views: null as string[] | null,
              message,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          const selection = getSelection(getCode(), refdes);
          const ready = getBoardState(sessionId).ready;
          if (!selection) {
            const message = `composant ${refdes} introuvable dans le TSX`;
            const output = {
              sessionId,
              op: asked,
              applied: false as const,
              ready,
              stats: emptyStats(),
              diagnostics: [{ severity: "error", message, source: "live_manage" }],
              mode: "lecture",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: getCode(),
              selection: null,
              views: null as string[] | null,
              message,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          const output = {
            sessionId,
            op: asked,
            applied: true as const,
            ready,
            stats: emptyStats(),
            diagnostics: [],
            mode: "lecture",
            banner: null as string | null,
            errors: 0,
            warnings: 0,
            circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: getCode(),
            selection,
            views: null as string[] | null,
            message: null as string | null,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }

        if (asked === "view") {
          const ready = getBoardState(sessionId).ready;
          const views = listViews();
          const output = {
            sessionId,
            op: asked,
            applied: true as const,
            ready,
            stats: emptyStats(),
            diagnostics: [],
            mode: "lecture",
            banner: null as string | null,
            errors: 0,
            warnings: 0,
            circuitJsonLength: 0,
            circuitJson: [] as unknown[],
            code: getCode(),
            selection: null,
            views,
            message: null as string | null,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }

        // Mutations write-through sérialisées par la file.
        return enqueue(async () => {
          const code = getCode();
          let mutated;
          switch (asked) {
            case "move":
              if (x === undefined || y === undefined) {
                mutated = { ok: false as const, message: "move exige x et y (nombres, mm)" };
              } else {
                mutated = applyMove(code, refdes ?? "", x, y);
              }
              break;
            case "rotate":
              if (degrees === undefined) {
                mutated = { ok: false as const, message: "rotate exige degrees (nombre)" };
              } else {
                mutated = applyRotate(code, refdes ?? "", degrees);
              }
              break;
            case "swap_package":
              if (!footprint) {
                mutated = { ok: false as const, message: "swap_package exige footprint (ex 0603)" };
              } else {
                mutated = applySwapPackage(code, refdes ?? "", footprint);
              }
              break;
            case "reassign_net":
              if (!pin || !net) {
                mutated = { ok: false as const, message: "reassign_net exige pin et net (ex pin1, GND)" };
              } else {
                mutated = applyReassignNet(code, refdes ?? "", pin, net);
              }
              break;
            default: {
              const message =
                `op live "${asked}" inconnue (live V1 : move | rotate | swap_package | reassign_net + select/view) — ` +
                `création/suppression via code_patch`;
              const ready = getBoardState(sessionId).ready;
              const output = {
                sessionId,
                op: asked,
                applied: false as const,
                ready,
                stats: emptyStats(),
                diagnostics: [{ severity: "error", message, source: "live_manage" }],
                mode: "refuse",
                banner: null as string | null,
                errors: 1,
                warnings: 0,
                circuitJsonLength: 0,
                circuitJson: [] as unknown[],
                code: null as string | null,
                selection: null,
                views: null as string[] | null,
                message,
              };
              appendLog("error", "compile", `live_manage ${asked} inconnu`);
              return {
                content: [{ type: "text", text: JSON.stringify(output) }],
                structuredContent: output,
              };
            }
          }
          if (!mutated.ok) {
            const ready = getBoardState(sessionId).ready;
            const output = {
              sessionId,
              op: asked,
              applied: false as const,
              ready,
              stats: emptyStats(),
              diagnostics: [
                { severity: "error", message: mutated.message, source: "live_manage" },
              ],
              mode: "refuse",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: null as string | null,
              selection: null,
              views: null as string[] | null,
              message: mutated.message,
            };
            appendLog("error", "compile", `live_manage ${asked} rejeté : ${mutated.message}`);
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          const compiled = await compileTsx(mutated.code, { disableCdnLoading });
          const ready = compiled.errors === 0;
          setLastCompile({
            status: compiled.errors === 0 ? "ok" : "error",
            errors: compiled.errors,
            warnings: compiled.warnings,
          });
          if (compiled.errors === 0) {
            try {
              // `setCode` suit la persistance réussie (cf. code_patch).
              persistCurrent(projLive, mutated.code, compiled.circuitJson);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              appendLog("error", "compile", `live_manage disque KO : ${message}`);
              const output = {
                sessionId,
                op: asked,
                applied: false as const,
                ready: false,
                stats: compiled.stats,
                diagnostics: [{ severity: "error", message, source: "live_manage" }],
                mode: "echec",
                banner: compiled.banner,
                errors: 1,
                warnings: compiled.warnings,
                circuitJsonLength: 0,
                circuitJson: [] as unknown[],
                code: mutated.code,
                selection: null,
                views: null as string[] | null,
                message,
              };
              return {
                content: [{ type: "text", text: JSON.stringify(output) }],
                structuredContent: output,
              };
            }
            setCode(mutated.code);
            appendLog("info", "compile", `live_manage ${asked} ok : ${compiled.stats.total} éléments, 0 erreur`);
          } else {
            // Compile en erreur : mémoire à jour (sonnette pcb_state), disque
            // inchangé, diagnostics exploitables — comportement inchangé.
            setCode(mutated.code);
            appendLog(
              "error",
              "compile",
              `live_manage ${asked} compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
            );
          }
          const output = {
            sessionId,
            op: asked,
            applied: true as const,
            ready,
            stats: compiled.stats,
            diagnostics: compiled.diagnostics,
            mode: compiled.mode,
            banner: compiled.banner,
            errors: compiled.errors,
            warnings: compiled.warnings,
            circuitJsonLength: compiled.circuitJson.length,
            circuitJson: compiled.circuitJson,
            code: mutated.code,
            selection: null,
            views: null as string[] | null,
            message: null as string | null,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        });
      },
    );

    server.registerTool(
      "preview_screenshot",
      {
        title: "Screenshot preview agent",
        description:
          "Lit le dernier screenshot PNG déposé par la WebView (onglets Schéma/PCB/3D, compile partagée) : retourne base64 + taille + lien preview locale file://. Absent → message explicite « ouvre l'app ». Jamais d'image inventée ; offline strict → bandeau.",
        inputSchema: PreviewScreenshotInput,
        outputSchema: PreviewScreenshotOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ session_id, source, name, disableCdnLoading }) => {
        const sessionId = session_id ?? "default";
        const projPrev = currentProjectPath();
        // Jail Confinement (#42) : lecture capture refusée hors Registre
        // (sans repli vers le cache global — un projet ouvert hors périmètre
        // ne doit ni lire son dossier ni fuir vers un autre).
        const scopeErrPrev = checkConfined("preview_screenshot", projPrev);
        if (scopeErrPrev) {
          const output = {
            sessionId,
            source: String(source ?? ""),
            name: (typeof name === "string" ? name : null) as string | null,
            found: false,
            dataUrl: null,
            bytes: 0,
            width: null,
            height: null,
            previewUrl: null,
            updatedAt: null,
            banner: null,
            message: scopeErrPrev.message,
            errors: 1,
            warnings: 0,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...scopeErrPrev }) }],
            structuredContent: output,
          };
        }
        // Priorité <Projet ouvert>/previews/, fallback override tests / cache global.
        const previewOverride = (process.env.PCB_MCP_PREVIEW_DIR ?? "").trim();
        const projectDir = projPrev ? projectPreviewsDir(projPrev) : "";
        const previewDirEff = projectDir || previewOverride;
        if (!previewDirEff) {
          const err = noProjectError("preview_screenshot");
          const output = {
            sessionId,
            source: String(source ?? ""),
            name: (typeof name === "string" ? name : null) as string | null,
            found: false,
            dataUrl: null,
            bytes: 0,
            width: null,
            height: null,
            previewUrl: null,
            updatedAt: null,
            banner: null,
            message: err.message,
            errors: 1,
            warnings: 0,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
            structuredContent: output,
          };
        }
        let read = readPreview(source ?? "", { dir: previewDirEff, disableCdnLoading, name });
        if (!read.found && previewOverride && previewOverride !== previewDirEff) {
          read = readPreview(source ?? "", { dir: previewOverride, disableCdnLoading, name });
        }
        if (read.found) {
          appendLog("info", "export", `preview_screenshot ${read.source} ok : ${read.bytes} octets`);
        } else {
          appendLog("warn", "export", `preview_screenshot ${String(source)} introuvable : ${read.message ?? "inconnu"}`);
        }
        const output = {
          sessionId,
          source: String(read.source),
          name: read.name,
          found: read.found,
          dataUrl: read.dataUrl,
          bytes: read.bytes,
          width: read.width,
          height: read.height,
          previewUrl: read.previewUrl,
          updatedAt: read.updatedAt,
          banner: read.banner,
          message: read.message,
          errors: read.errors,
          warnings: read.warnings,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "batch_execute",
      {
        title: "Lot atomique + une approbation",
        description:
          "Applique un lot mixte patch+live+route en une seule approbation : toutes les ops en mémoire puis une seule compile. Op `route` : épingle l'autorouteur local (effort configurable) et exige le gate placement + routage effectif. Échec (op invalide, compile en erreur ou gate route rouge) → rollback complet fichier+live, état inchangé. Une itération = un seul tools/call.",
        inputSchema: BatchExecuteInput,
        outputSchema: BatchExecuteOutput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ session_id, operations, disableCdnLoading }) => {
        return enqueue(async () => {
          const sessionId = session_id ?? "default";
          const projBatch = currentProjectPath();
          // Jail Confinement (#42) : lot atomique refusé hors Registre.
          const scopeErrBatch = checkConfined("batch_execute", projBatch);
          if (!projBatch || scopeErrBatch) {
            const err = scopeErrBatch ?? noProjectError("batch_execute");
            const output = {
              sessionId,
              applied: false as const,
              ready: false,
              failedOpIndex: null as number | null,
              rolledBack: false,
              stats: emptyStats(),
              diagnostics: [{ severity: "error", message: err.message, source: "batch_execute" }],
              mode: "refuse",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: null as string | null,
            };
            return {
              content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
              structuredContent: output,
            };
          }
          const ops = (operations ?? []) as BatchOp[];
          if (!Array.isArray(ops) || ops.length === 0) {
            const ready = getBoardState(sessionId).ready;
            const output = {
              sessionId,
              applied: false as const,
              ready,
              failedOpIndex: null as number | null,
              rolledBack: false,
              stats: emptyStats(),
              diagnostics: [
                {
                  severity: "error",
                  message: "lot vide : fournissez au moins une opération",
                  source: "batch_execute",
                },
              ],
              mode: "refuse",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: null as string | null,
            };
            appendLog("error", "compile", "batch_execute rejeté : lot vide");
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          const snap = snapshotStore();
          const batched = applyBatch(snap.code, ops);
          if (!batched.ok) {
            restoreStore(snap);
            const ready = getBoardState(sessionId).ready;
            const output = {
              sessionId,
              applied: false as const,
              ready,
              failedOpIndex: batched.failedIndex as number | null,
              rolledBack: true,
              stats: emptyStats(),
              diagnostics: [
                { severity: "error", message: batched.message, source: "batch_execute" },
              ],
              mode: "echec",
              banner: null as string | null,
              errors: 1,
              warnings: 0,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: snap.code,
            };
            appendLog(
              "error",
              "compile",
              `batch_execute rollback : op ${batched.failedIndex} — ${batched.message}`,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          setCode(batched.code);
          const compiled = await compileTsx(batched.code, { disableCdnLoading });
          if (compiled.errors !== 0) {
            restoreStore(snap);
            const ready = getBoardState(sessionId).ready;
            const output = {
              sessionId,
              applied: false as const,
              ready,
              failedOpIndex: null as number | null,
              rolledBack: true,
              stats: emptyStats(),
              diagnostics: compiled.diagnostics,
              mode: "echec",
              banner: compiled.banner,
              errors: compiled.errors,
              warnings: compiled.warnings,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: snap.code,
            };
            appendLog(
              "error",
              "compile",
              `batch_execute rollback : compile en erreur — ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          // Gate route (#44) : si le lot contient une op `route`, la compile
          // verte ne suffit pas — le placement doit être vert (sinon le
          // moteur ignore l'autoroutage) et le circuit-json doit être
          // effectivement routé. Sinon rollback, état inchangé.
          if (ops.some((o) => o.kind === "route")) {
            const gate = await runPlacementGate(compiled.circuitJson, batched.code);
            const blockReason = !gate.routingAllowed
              ? (gate.blockReason ?? "placement non vert")
              : !isBoardRouted(compiled.circuitJson)
                ? "board non routé : aucune pcb_trace avec route dans le circuit-json — vérifiez le placement puis relancez"
                : null;
            if (blockReason) {
              restoreStore(snap);
              const ready = getBoardState(sessionId).ready;
              const output = {
                sessionId,
                applied: false as const,
                ready,
                failedOpIndex: null as number | null,
                rolledBack: true,
                stats: emptyStats(),
                diagnostics: [
                  { severity: "error", message: `routing refusé : ${blockReason}`, source: "batch_execute" },
                ],
                mode: "echec",
                banner: compiled.banner,
                errors: 1,
                warnings: compiled.warnings,
                circuitJsonLength: 0,
                circuitJson: [] as unknown[],
                code: snap.code,
              };
              appendLog(
                "error",
                "compile",
                `batch_execute rollback : routing refusé — ${blockReason}`,
              );
              return {
                content: [{ type: "text", text: JSON.stringify(output) }],
                structuredContent: output,
              };
            }
          }
          setLastCompile({ status: "ok", errors: 0, warnings: compiled.warnings });
          appendLog(
            "info",
            "compile",
            `batch_execute ok : ${ops.length} ops, ${compiled.stats.total} éléments, 0 erreur`,
          );
          try {
            persistCurrent(projBatch, batched.code, compiled.circuitJson);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            appendLog("error", "compile", `batch_execute disque KO : ${message}`);
            restoreStore(snap);
            const ready = getBoardState(sessionId).ready;
            const output = {
              sessionId,
              applied: false as const,
              ready,
              failedOpIndex: null as number | null,
              rolledBack: true,
              stats: compiled.stats,
              diagnostics: [{ severity: "error", message, source: "batch_execute" }],
              mode: "echec",
              banner: compiled.banner,
              errors: 1,
              warnings: compiled.warnings,
              circuitJsonLength: 0,
              circuitJson: [] as unknown[],
              code: snap.code,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            };
          }
          const output = {
            sessionId,
            applied: true as const,
            ready: true,
            failedOpIndex: null as number | null,
            rolledBack: false,
            stats: compiled.stats,
            diagnostics: compiled.diagnostics,
            mode: compiled.mode,
            banner: compiled.banner,
            errors: 0,
            warnings: compiled.warnings,
            circuitJsonLength: compiled.circuitJson.length,
            circuitJson: compiled.circuitJson,
            code: batched.code,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        });
      },
    );

    server.registerTool(
      "search_parts",
      {
        title: "Sourcing JLCPCB-first + footprint",
        description:
          "Recherche une pièce JLCPCB (même source que `tsci search --jlcpcb`) : réf LCSC + footprint utilisable dans le TSX (footprinter_string IoU ≥ 95 % sinon fallback package validé par le DSL footprinter local). Empreinte manquante → DSL footprinter généré et compilé. Équivalent CLI : `tsci search --jlcpcb \"<query>\"` / `tsci import \"<Cxxxx>\" --jlcpcb`. Offline strict → refus explicite, rien d'inventé.",
        inputSchema: SearchPartsInput,
        outputSchema: SearchPartsOutput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ session_id, query, source, limit, disableCdnLoading }) => {
        if (!currentProjectPath()) {
          const err = noProjectError("search_parts");
          const output = {
            sessionId: session_id ?? "default",
            query: (query ?? "").trim(),
            source: (source ?? "jlcpcb").trim().toLowerCase(),
            tsciSearch: "",
            results: [],
            banner: null as string | null,
            message: err.message,
            errors: 1,
            warnings: 0,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
            structuredContent: output,
          };
        }
        const sessionId = session_id ?? "default";
        const src = (source ?? "jlcpcb").trim().toLowerCase();
        if (src !== "jlcpcb" && src !== "lcsc") {
          const message =
            `source "${source}" non supportée au MVP (sourcing JLCPCB-first, décision carte #6) : ` +
            `multi-sourcing (DigiKey/Mouser/Farnell) différé V2 — utilisez source=jlcpcb (ou alias lcsc)`;
          appendLog("error", "export", `search_parts source refusée : ${source}`);
          const output = {
            sessionId,
            query: (query ?? "").trim(),
            source: src,
            tsciSearch: `tsci search --jlcpcb "${(query ?? "").trim()}"`,
            results: [],
            banner: null as string | null,
            message,
            errors: 1,
            warnings: 0,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        const found = await searchParts(query ?? "", { limit: limit ?? 5, disableCdnLoading });
        if (!found.ok) {
          appendLog("error", "export", `search_parts "${query ?? ""}" impossible : ${found.message}`);
          const output = {
            sessionId,
            query: found.query,
            source: src,
            tsciSearch: found.tsciSearch,
            results: [],
            banner: found.banner,
            message: found.message,
            errors: 1,
            warnings: 0,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        appendLog(
          "info",
          "export",
          `search_parts "${found.query}" : ${found.results.length} résultat(s) JLCPCB`,
        );
        const output = {
          sessionId,
          query: found.query,
          source: src,
          tsciSearch: found.tsciSearch,
          results: found.results,
          banner: null as string | null,
          message: found.message,
          errors: 0,
          warnings: 0,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "fab_export",
      {
        title: "Exports fab V1 (gerbers + PnP + BOM + kicad_zip)",
        description:
          "Exporte la board courante en un geste : gerbers RS-274X + Excellon, BOM CSV, pick-and-place CSV et projet KiCad (.kicad_pcb + .kicad_sch + .kicad_pro, silencieux) + zips kicad_project.zip et fab_upload.zip (JLCPCB). Compile d'abord le TSX courant ; compile en erreur → aucun fichier inventé.",
        inputSchema: FabExportInput,
        outputSchema: FabExportOutput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ session_id, project_name, disableCdnLoading }) => {
        const projFab = currentProjectPath();
        // Jail Confinement (#42) : export refusé hors Registre.
        const scopeErrFab = checkConfined("fab_export", projFab);
        if (!projFab || scopeErrFab) {
          const err = scopeErrFab ?? noProjectError("fab_export");
          const output = {
            sessionId: session_id ?? "default",
            ready: false as const,
            mode: "refuse",
            banner: null as string | null,
            errors: 1,
            warnings: 0,
            counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
            gerberNames: [],
            gerberPreview: "",
            bomCsv: "",
            pnpCsv: "",
            kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
            kicadZip: { bytes: 0, previewUrl: "" },
            fabZip: { bytes: 0, previewUrl: "" },
            artifacts: [],
            exportDir: "",
            message: err.message,
          };
          return {
            content: [{ type: "text", text: JSON.stringify({ ...output, ...err }) }],
            structuredContent: output,
          };
        }
        const sessionId = session_id ?? "default";
        const code = getCode();
        const compiled = await compileTsx(code, { disableCdnLoading });
        // Runner en échec (exception) → aucun circuit-json : pas de gate.
        if (compiled.mode === "echec") {
          appendLog(
            "error",
            "export",
            `fab_export impossible : compile en erreur — ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
          );
          const output = {
            sessionId,
            ready: false as const,
            mode: "echec",
            banner: compiled.banner,
            errors: compiled.errors,
            warnings: compiled.warnings,
            counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
            gerberNames: [],
            gerberPreview: "",
            bomCsv: "",
            pnpCsv: "",
            kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
            kicadZip: { bytes: 0, previewUrl: "" },
            fabZip: { bytes: 0, previewUrl: "" },
            artifacts: [],
            exportDir: "",
            message: `compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"} — corrigez via code_patch avant tout export`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        // Gate board routé (#44) : le routage déclaré interdit
        // (`routingDisabled`) est refusé avec un message explicite avant le
        // gate DRC (dont le décompte générique masquerait la cause).
        // L'export sort d'un board routé par l'autorouteur local.
        if (boardRoutingDisabled(code)) {
          const reason =
            "routingDisabled déclaré sur <board> — retirez-le via code_patch et routez (batch_execute route) avant tout export";
          appendLog("error", "export", `fab_export refusé : board non routé — ${reason}`);
          const output = {
            sessionId,
            ready: false as const,
            mode: "refuse",
            banner: compiled.banner,
            errors: 1,
            warnings: 0,
            counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
            gerberNames: [],
            gerberPreview: "",
            bomCsv: "",
            pnpCsv: "",
            kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
            kicadZip: { bytes: 0, previewUrl: "" },
            fabZip: { bytes: 0, previewUrl: "" },
            artifacts: [],
            exportDir: "",
            message: `board non routé : ${reason}`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        // Gate DRC obligatoire avant export (#39) : placement vert exigé et
        // zéro violation tous domaines (routing exclu si interdit, comme run_checks).
        const gate = await runPlacementGate(compiled.circuitJson, code);
        const allViolations = await runDomainChecks(compiled.circuitJson, "all");
        const drcViolations = gate.routingAllowed
          ? allViolations
          : allViolations.filter((v) => v.domain !== "routing");
        if (!gate.placementGreen || drcViolations.length > 0) {
          const reason =
            gate.blockReason ?? `${drcViolations.length} violation(s) DRC à corriger`;
          setDrcViolations(drcViolations.length);
          appendLog("error", "export", `fab_export refusé : DRC rouge — ${reason}`);
          const output = {
            sessionId,
            ready: false as const,
            mode: "refuse",
            banner: compiled.banner,
            errors: 1,
            warnings: 0,
            counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
            gerberNames: [],
            gerberPreview: "",
            bomCsv: "",
            pnpCsv: "",
            kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
            kicadZip: { bytes: 0, previewUrl: "" },
            fabZip: { bytes: 0, previewUrl: "" },
            artifacts: [],
            exportDir: "",
            message: `DRC rouge : ${reason} — corrigez via code_patch/run_checks avant tout export`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        setDrcViolations(0);
        // Preuve de routage effectif (#44, résiduel après gate DRC) : des
        // `<trace>` déclarées mais aucune `pcb_trace` routée (autoroutage
        // ignoré) → export refusé, jamais de gerbers sans cuivre.
        if (boardExpectsRouting(code) && !isBoardRouted(compiled.circuitJson)) {
          const reason =
            "aucune trace routée dans le circuit-json — routez via batch_execute (op route) avant tout export";
          appendLog("error", "export", `fab_export refusé : board non routé — ${reason}`);
          const output = {
            sessionId,
            ready: false as const,
            mode: "refuse",
            banner: compiled.banner,
            errors: 1,
            warnings: 0,
            counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
            gerberNames: [],
            gerberPreview: "",
            bomCsv: "",
            pnpCsv: "",
            kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
            kicadZip: { bytes: 0, previewUrl: "" },
            fabZip: { bytes: 0, previewUrl: "" },
            artifacts: [],
            exportDir: "",
            message: `board non routé : ${reason}`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        // Erreurs embarquées résiduelles (gate vert, checks verts, mais
        // circuit-json en erreur : ex empreinte invalide) → export refusé
        // comme une compile en erreur, jamais de gerbers inventés.
        if (compiled.errors > 0) {
          appendLog(
            "error",
            "export",
            `fab_export impossible : compile en erreur — ${compiled.diagnostics.find((d) => d.severity === "error")?.message ?? "inconnu"}`,
          );
          const output = {
            sessionId,
            ready: false as const,
            mode: "echec",
            banner: compiled.banner,
            errors: compiled.errors,
            warnings: compiled.warnings,
            counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
            gerberNames: [],
            gerberPreview: "",
            bomCsv: "",
            pnpCsv: "",
            kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
            kicadZip: { bytes: 0, previewUrl: "" },
            fabZip: { bytes: 0, previewUrl: "" },
            artifacts: [],
            exportDir: "",
            message: `compile en erreur : ${compiled.diagnostics.find((d) => d.severity === "error")?.message ?? "inconnu"} — corrigez via code_patch avant tout export`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        const fab = await exportFab(compiled.circuitJson as unknown[], {
          projectName: (process.env.PCB_MCP_EXPORT_DIR ?? "").trim()
            ? (project_name ?? path.basename(projFab))
            : path.basename(projFab),
        });
        if (!fab.ok) {
          appendLog("error", "export", `fab_export impossible : ${fab.message}`);
          const output = {
            sessionId,
            ready: false as const,
            mode: "echec",
            banner: compiled.banner,
            errors: 1,
            warnings: 0,
            counts: { gerberFiles: 0, bomRows: 0, pnpRows: 0 },
            gerberNames: [],
            gerberPreview: "",
            bomCsv: "",
            pnpCsv: "",
            kicad: { pcbBytes: 0, schBytes: 0, proBytes: 0, pcbPreview: "" },
            kicadZip: { bytes: 0, previewUrl: "" },
            fabZip: { bytes: 0, previewUrl: "" },
            artifacts: [],
            exportDir: "",
            message: fab.message,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        const out = fab as FabOk;
        // Override tests PCB_MCP_EXPORT_DIR prioritaire (suites historiques),
        // sinon <projet>/exports/<basename>-<hash12(canonique)> (homonymes distingués).
        const exportOverride = (process.env.PCB_MCP_EXPORT_DIR ?? "").trim();
        const dir = exportOverride
          ? path.join(exportOverride, sanitizeSegment(sessionId), sanitizeSegment(out.projectName))
          : projectExportDir(canonicalProjectPath(projFab));
        fs.mkdirSync(dir, { recursive: true });
        fs.mkdirSync(path.join(dir, "gerbers"), { recursive: true });
        const artifacts = writeFabArtifacts(out, {
          dir,
          writeFile: (p, content) => fs.writeFileSync(p, content),
          toFileUrl: (p) => pathToFileURL(p).href,
          join: (...parts) => path.join(...parts),
        });
        const byName = (n: string) => artifacts.find((a) => a.name === n);
        appendLog(
          "info",
          "export",
          `fab_export ok : ${out.counts.gerberFiles} gerbers, BOM ${out.counts.bomRows} lignes, PnP ${out.counts.pnpRows} lignes, kicad silencieux → ${dir}`,
        );
        const output = {
          sessionId,
          ready: true as const,
          mode: compiled.mode,
          banner: compiled.banner,
          errors: 0,
          warnings: compiled.warnings,
          counts: out.counts,
          gerberNames: out.gerberNames,
          gerberPreview: out.gerberPreview,
          bomCsv: out.bomCsv,
          pnpCsv: out.pnpCsv,
          kicad: {
            pcbBytes: Buffer.byteLength(out.kicadPcb),
            schBytes: Buffer.byteLength(out.kicadSch),
            proBytes: Buffer.byteLength(out.kicadPro),
            pcbPreview: out.kicadPcbPreview,
          },
          kicadZip: {
            bytes: out.kicadZipBytes,
            previewUrl: byName("kicad_project.zip")?.previewUrl ?? "",
          },
          fabZip: {
            bytes: out.fabZipBytes,
            previewUrl: byName("fab_upload.zip")?.previewUrl ?? "",
          },
          artifacts,
          exportDir: dir,
          message: null as string | null,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    return server;
  };
}

export function buildHandler() {
  // `legacy: 'stateless'` = moderne 2026-07-28 + fallback legacy initialize.
  return createMcpHandler(buildFactory(), { legacy: "stateless" });
}
