// Fabrique MCP (SDK TS v2 brut, pas mcp-use — findings §5 / spec #8).
// Une seule factory pour les deux eras : moderne 2026-07-28 + fallback
// legacy initialize stateless (createMcpHandler défaut `legacy: 'stateless'`).
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { emptyStats } from "./board.js";
import { compileTsx } from "./compile.js";
import { applyAnchoredPatch } from "./patch.js";
import {
  appendLog,
  getBoardState,
  getCode,
  getHierarchy,
  readLogs,
  setCode,
  setLastCompile,
} from "./state.js";

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

export function buildFactory() {
  return () => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } },
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
            text: JSON.stringify(getHierarchy()),
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
        const sessionId = session_id ?? "default";
        const patched = applyAnchoredPatch(getCode(), anchor, replacement);
        if (!patched.ok) {
          const output = {
            sessionId,
            applied: false as const,
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
        setCode(patched.code);
        const compiled = await compileTsx(patched.code, { disableCdnLoading });
        setLastCompile({
          status: compiled.errors === 0 ? "ok" : "error",
          errors: compiled.errors,
          warnings: compiled.warnings,
        });
        if (compiled.errors === 0) {
          appendLog(
            "info",
            "compile",
            `code_patch ok : ${compiled.stats.total} éléments, 0 erreur`,
          );
        } else {
          appendLog(
            "error",
            "compile",
            `code_patch compile en erreur : ${compiled.diagnostics[0]?.message ?? "inconnu"}`,
          );
        }
        const output = {
          sessionId,
          applied: true as const,
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
      },
    );

    return server;
  };
}

export function buildHandler() {
  // `legacy: 'stateless'` = moderne 2026-07-28 + fallback legacy initialize.
  return createMcpHandler(buildFactory(), { legacy: "stateless" });
}
