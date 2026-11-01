#!/usr/bin/env bun
// CLI `pcb-mcp serve --port <n>` — token UNIQUEMENT via PCB_MCP_TOKEN
// (jamais en argv : visible via `ps`, cf. findings §10).
// Usage Tauri prod (capability verrouillée) : args ["serve", "--port", "<digits>"],
// token injecté par env (jamais loggé).
import { startServer } from "./http.js";
import { setLogFile, logLine } from "./log.js";

function usage(): string {
  return [
    "Usage:",
    "  pcb-mcp serve --port <1..65535> [--log-file <path>]",
    "  pcb-mcp --version | --help",
    "",
    "Env:",
    "  PCB_MCP_TOKEN    bearer éphémère (requis, jamais en argv)",
    "  PCB_MCP_PORT     port par défaut si --port absent",
    "  PCB_MCP_LOG_FILE fichier de logs en plus de stderr",
  ].join("\n");
}

function argValue(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]!)) return args[i + 1];
    const m = args[i]!.match(/^--(port|log-file)=(.+)$/);
    if (m && names.includes(`--${m[1]}`)) return m[2];
  }
  return undefined;
}

export function parseServeArgs(argv: string[]): { port: number; token: string; logFile?: string } {
  const cmd = argv[2];
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.error(usage());
    process.exit(0);
  }
  if (cmd === "--version" || cmd === "-V") {
    console.error("pcb-mcp 0.1.0");
    process.exit(0);
  }
  if (cmd !== "serve") {
    console.error(usage());
    process.exit(2);
  }
  const portRaw = argValue(argv.slice(3), "--port") ?? process.env.PCB_MCP_PORT;
  const token = process.env.PCB_MCP_TOKEN;
  const logFile = argValue(argv.slice(3), "--log-file") ?? process.env.PCB_MCP_LOG_FILE;
  const port = Number(portRaw);
  if (!portRaw || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[pcb-mcp] [error] --port invalide : ${portRaw ?? "(absent)"}`);
    console.error(usage());
    process.exit(2);
  }
  if (!token) {
    console.error("[pcb-mcp] [error] token requis : PCB_MCP_TOKEN (jamais en argv)");
    process.exit(2);
  }
  return { port, token, logFile };
}

if (import.meta.main) {
  const { port, token, logFile } = parseServeArgs(process.argv);
  setLogFile(logFile);
  const server = await startServer({ port, token });
  const shutdown = () => {
    logLine("info", "arrêt demandé, fermeture");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
