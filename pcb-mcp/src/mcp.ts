// Fabrique MCP (SDK TS v2 brut, pas mcp-use — findings §5 / spec #8).
// ADAPTATEUR FIN T1 (#56) : Zod → gardes → file → cœur → structuredContent.
// Aucune logique métier ici : toute l'orchestration vit dans
// `tools-core/tools.ts` à effets injectés (`src/deps.ts` : compile Bun,
// persistance atomique, lockfile/Registre). Règle d'or inchangée : le disque
// (main.tsx + circuit.json v1) est la source unique de vérité.
// Une seule factory pour les deux eras : moderne 2026-07-28 + fallback
// legacy initialize stateless (createMcpHandler défaut `legacy: 'stateless'`).
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { TOOL_DEFS } from "./tools-core/manifest.js";
import { enqueue } from "./tools-core/queue.js";
import {
  liveOpNeedsQueue,
  readHierarchy,
  runBatchExecute,
  runChecks,
  runCodePatch,
  runFabExport,
  runLiveManage,
  runLogsRead,
  runPcbState,
  runPreviewScreenshot,
  runProjectClose,
  runProjectCreate,
  runProjectCurrent,
  runProjectList,
  runProjectOpen,
  runSearchParts,
  type ToolResult,
} from "./tools-core/tools.js";
import { getToolsDeps, loadOpenProjectCode } from "./deps.js";
import type { ToolsDeps } from "./tools-core/deps.js";

export { loadOpenProjectCode };

export const SERVER_NAME = "pcb-mcp";
export const SERVER_VERSION = "0.1.0";

/** Met en forme la réponse MCP (texte JSON + structuredContent Zod). */
function toMcp<T>(r: ToolResult<T>) {
  return {
    content: [{ type: "text" as const, text: r.text }],
    structuredContent: r.output,
  };
}

export function buildFactory() {
  return () => {
    const deps: ToolsDeps = getToolsDeps();
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } },
    );

    server.registerTool(
      "project_list",
      TOOL_DEFS.project_list,
      async () => toMcp(await runProjectList(deps)),
    );

    server.registerTool(
      "project_current",
      TOOL_DEFS.project_current,
      async () => toMcp(await runProjectCurrent(deps)),
    );

    server.registerTool(
      "project_create",
      TOOL_DEFS.project_create,
      async (args) => enqueue(async () => toMcp(await runProjectCreate(deps, args))),
    );

    server.registerTool(
      "project_open",
      TOOL_DEFS.project_open,
      async (args) => enqueue(async () => toMcp(await runProjectOpen(deps, args))),
    );

    server.registerTool(
      "project_close",
      TOOL_DEFS.project_close,
      async () => enqueue(async () => toMcp(await runProjectClose(deps))),
    );

    server.registerTool(
      "pcb_state",
      TOOL_DEFS.pcb_state,
      async (args) => toMcp(await runPcbState(deps, args)),
    );

    server.registerTool(
      "logs_read",
      TOOL_DEFS.logs_read,
      async (args) => toMcp(await runLogsRead(deps, args)),
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
            text: readHierarchy(deps).text,
          },
        ],
      }),
    );

    server.registerTool(
      "code_patch",
      TOOL_DEFS.code_patch,
      async (args) => enqueue(async () => toMcp(await runCodePatch(deps, args))),
    );

    server.registerTool(
      "run_checks",
      TOOL_DEFS.run_checks,
      async (args) => toMcp(await runChecks(deps, args)),
    );

    server.registerTool(
      "live_manage",
      TOOL_DEFS.live_manage,
      async (args) => {
        // Lectures (select/view) + refus hors file, mutations sérialisées.
        if (!liveOpNeedsQueue(args.op ?? "")) return toMcp(await runLiveManage(deps, args));
        return enqueue(async () => toMcp(await runLiveManage(deps, args)));
      },
    );

    server.registerTool(
      "preview_screenshot",
      TOOL_DEFS.preview_screenshot,
      async (args) => toMcp(await runPreviewScreenshot(deps, args)),
    );

    server.registerTool(
      "batch_execute",
      TOOL_DEFS.batch_execute,
      async (args) => enqueue(async () => toMcp(await runBatchExecute(deps, args))),
    );

    server.registerTool(
      "search_parts",
      TOOL_DEFS.search_parts,
      async (args) => toMcp(await runSearchParts(deps, args)),
    );

    server.registerTool(
      "fab_export",
      TOOL_DEFS.fab_export,
      async (args) => toMcp(await runFabExport(deps, args)),
    );

    return server;
  };
}

export function buildHandler() {
  // `legacy: 'stateless'` = moderne 2026-07-28 + fallback legacy initialize.
  return createMcpHandler(buildFactory(), { legacy: "stateless" });
}
