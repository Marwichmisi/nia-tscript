// Contrat d'outils unique (T1, #56) : métadonnées consommées par
// `registerTool` (pilote externe) ET par le routeur agent (interne), avec
// manifeste généré pour le prompt système. Schémas dans `./schemas.ts`.
// Titres/descriptions/annotations repris VERBATIM de `src/mcp.ts`.
// Aucun import node: — consommable WebView.
import { z } from "zod";
import {
  ProjectListOutput,
  ProjectCreateInput,
  ProjectOpenInput,
  PcbStateInput,
  PcbStateOutput,
  LogsReadInput,
  LogsReadOutput,
  CodePatchInput,
  CodePatchOutput,
  RunChecksInput,
  RunChecksOutput,
  LiveManageInput,
  LiveManageOutput,
  PreviewScreenshotInput,
  PreviewScreenshotOutput,
  BatchExecuteInput,
  BatchExecuteOutput,
  SearchPartsInput,
  SearchPartsOutput,
  FabExportInput,
  FabExportOutput,
} from "./schemas.js";

export interface ToolDef {
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: Record<string, boolean>;
}

export const TOOL_DEFS = {
  project_list: {
        title: "Lister les projets",
        description: "Liste les Projets du Registre avec existence disque. Accessible sans Projet ouvert.",
        inputSchema: z.object({}),
        outputSchema: ProjectListOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
  project_current: {
        title: "Projet ouvert",
        description: "Retourne le Projet ouvert ou null si Accueil. Accessible sans Projet ouvert.",
        inputSchema: z.object({}),
        outputSchema: z.object({ current: z.string().nullable() }),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
  project_create: {
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
  project_open: {
        title: "Ouvrir un projet",
        description: "Ouvre un Projet existant (main.tsx requis), le marque lastOpened et charge son TSX.",
        inputSchema: ProjectOpenInput,
        outputSchema: z.object({
          path: z.string(),
          current: z.string().nullable(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
  project_close: {
        title: "Fermer le projet",
        description: "Ramène à l'Accueil et reverrouille le MCP (project_* seuls).",
        inputSchema: z.object({}),
        outputSchema: z.object({ current: z.string().nullable() }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
  pcb_state: {
        title: "État lecture du studio",
        description: "Lit l'état du studio (board ouverte, readiness, compile/DRC). Lecture seule.",
        inputSchema: PcbStateInput,
        outputSchema: PcbStateOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
  logs_read: {
        title: "Lecture des logs",
        description: "Lit les logs compilateur/ERC/DRC/export avec curseur et signalement des nouvelles erreurs.",
        inputSchema: LogsReadInput,
        outputSchema: LogsReadOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
  code_patch: {
        title: "Patch TSX ancré + diagnostics",
        description:
          "Applique un patch TSX ancré (une occurrence exacte) puis compile (core+eval offline-first) : retourne circuit-json, diagnostics compilateur et stats.",
        inputSchema: CodePatchInput,
        outputSchema: CodePatchOutput,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
  run_checks: {
        title: "Contrôles natifs + gate placement",
        description:
          "Lance les contrôles natifs tscircuit (netlist, placement, routing, style PCB) sur le TSX courant et retourne les violations positionnées. Gate dur : le domaine routing est refusé tant que le placement n'est pas vert (coordonnées pcbX/pcbY explicites exigées).",
        inputSchema: RunChecksInput,
        outputSchema: RunChecksOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
  live_manage: {
        title: "Live-mutation restreinte write-through",
        description:
          "Mutation live restreinte (move | rotate | swap_package | reassign_net + select/view) : réécrit le TSX aussitôt puis recompile, readiness stampée. Création/suppression refusées vers code_patch. Écritures sérialisées par la file.",
        inputSchema: LiveManageInput,
        outputSchema: LiveManageOutput,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
  preview_screenshot: {
        title: "Screenshot preview agent",
        description:
          "Lit le dernier screenshot PNG déposé par la WebView (onglets Schéma/PCB/3D, compile partagée) : retourne base64 + taille + lien preview locale file://. Absent → message explicite « ouvre l'app ». Jamais d'image inventée ; offline strict → bandeau.",
        inputSchema: PreviewScreenshotInput,
        outputSchema: PreviewScreenshotOutput,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
  batch_execute: {
        title: "Lot + une approbation",
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
  search_parts: {
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
  fab_export: {
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
} satisfies Record<string, ToolDef>;

/** Ressource hiérarchie (miroir lecture, pas un outil). */
export const HIERARCHY_RESOURCE = {
  name: "hierarchy",
  uri: "pcb://hierarchy",
  title: "Hiérarchie du circuit",
  description: "Hiérarchie board → modules → composants → pins (miroir lecture).",
  mimeType: "application/json",
} as const;

export interface ManifestEntry {
  name: string;
  title: string;
  description: string;
  annotations: Record<string, boolean>;
}

/** Manifeste généré pour le prompt système de l'agent (nom/description/annotations). */
export function buildToolsManifest(): ManifestEntry[] {
  return (Object.entries(TOOL_DEFS) as Array<[string, ToolDef]>).map(([name, def]) => ({
    name,
    title: def.title,
    description: def.description,
    annotations: def.annotations,
  }));
}
