// Fabrique MCP (SDK TS v2 brut, pas mcp-use — findings §5 / spec #8).
// Une seule factory pour les deux eras : moderne 2026-07-28 + fallback
// legacy initialize stateless (createMcpHandler défaut `legacy: 'stateless'`).
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getBoardState, getHierarchy, readLogs } from "./state.js";

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

    return server;
  };
}

export function buildHandler() {
  // `legacy: 'stateless'` = moderne 2026-07-28 + fallback legacy initialize.
  return createMcpHandler(buildFactory(), { legacy: "stateless" });
}
