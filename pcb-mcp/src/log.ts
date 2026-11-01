// Logger stderr-only (#10) : jamais de sortie sur stdout (stdout = MCP pur
// côté bridge, et côté HTTP stdout doit rester silencieuse).
// Option fichier via PCB_MCP_LOG_FILE (append sync, best-effort).
import fs from "node:fs";

let logFile: string | null = null;

export function setLogFile(path: string | null | undefined) {
  logFile = path ?? null;
}

export function logLine(level: "info" | "warn" | "error" | "debug", msg: string) {
  const line = `[pcb-mcp] [${level}] ${msg}`;
  console.error(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      // best-effort : ne jamais casser le serveur pour le fichier de logs.
    }
  }
}
