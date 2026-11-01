// Fabrique MCP (SDK TS v2 brut, pas mcp-use — findings §5 / spec #8).
// Une seule factory pour les deux eras : moderne 2026-07-28 + fallback
// legacy initialize stateless (createMcpHandler défaut `legacy: 'stateless'`).
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { emptyStats } from "./board.js";
import { runDomainChecks, runPlacementGate, type CheckDomain } from "./checks.js";
import { compileTsx } from "./compile.js";
import { applyAnchoredPatch } from "./patch.js";
import {
  appendLog,
  getBoardState,
  getCode,
  getHierarchy,
  readLogs,
  setCode,
  setDrcViolations,
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
        const sessionId = session_id ?? "default";
        const asked: CheckDomain = domain ?? "all";
        const code = getCode();
        const compiled = await compileTsx(code, { disableCdnLoading });
        if (compiled.errors !== 0) {
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
        const violations = await runDomainChecks(compiled.circuitJson, asked);
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
          errors: 0,
          warnings: 0,
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
