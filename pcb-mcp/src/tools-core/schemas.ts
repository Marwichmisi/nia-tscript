// Schémas d'outils versionnés (T1, #56) : contrat unique consommé par
// `registerTool` (pilote externe) et le routeur agent (interne), avec manifeste
// généré pour le prompt système (`./manifest.ts`). Extrait de `src/mcp.ts`
// SANS changer la logique (mêmes noms, mêmes descriptions, mêmes règles).
// Aucun import node: — `zod` pur, consommable WebView.
import { z } from "zod";
import { BATCH_MAX_OPS } from "./batch.js";
import { ROUTE_EFFORTS } from "./board.js";

export const PcbStateInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
});

export const PcbStateOutput = z.object({
  sessionId: z.string(),
  board: z.string(),
  ready: z.boolean(),
  compile: z.object({ status: z.string(), errors: z.number(), warnings: z.number() }),
  drc: z.object({ violations: z.number() }),
  protocolVersion: z.string(),
});

export const LogsReadInput = z.object({
  cursor: z.string().optional().describe("Seq de reprise (exclue)"),
  limit: z.number().int().min(1).max(100).optional().describe("1..100, défaut 20"),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
});

export const LogsReadOutput = z.object({
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
export const ProjectListOutput = z.object({
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

export const ProjectCreateInput = z.object({
  path: z.string().describe("Chemin dossier absolu, créé si absent"),
  template: z.enum(["vide", "demo"]).optional().describe("Contenu initial (défaut: vide)"),
});

export const ProjectOpenInput = z.object({
  path: z.string().describe("Chemin dossier absolu contenant main.tsx"),
});

export const CodePatchInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  anchor: z.string().min(1).describe("Extrait exact du TSX, exactement une occurrence"),
  replacement: z.string().describe("Texte de remplacement de l'ancre"),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

export const CodePatchOutput = z.object({
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

export const RunChecksInput = z.object({
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

export const ViolationOutput = z.object({
  domain: z.string(),
  type: z.string(),
  message: z.string(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  refdes: z.string().nullable(),
});

export const RunChecksOutput = z.object({
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

export const LiveManageInput = z.object({
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

export const LiveManageOutput = z.object({
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

export const PreviewScreenshotInput = z.object({
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

export const PreviewScreenshotOutput = z.object({
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

export const BatchOpSchema = z.union([
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

export const BatchExecuteInput = z.object({
  session_id: z.string().optional().describe("Session mono-board (défaut: default)"),
  operations: z
    .array(BatchOpSchema)
    .describe(
      `Lot patch+live+route (1..${BATCH_MAX_OPS}) : une seule approbation couvre l'itération complète, rollback si un op échoue`,
    ),
  disableCdnLoading: z
    .boolean()
    .optional()
    .describe(" true = offline strict (bandeau si dégradation réseau)"),
});

export const BatchExecuteOutput = z.object({
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

export const SearchPartsInput = z.object({
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

export const SearchPartsOutput = z.object({
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

export const FabExportInput = z.object({
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

export const FabExportOutput = z.object({
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
