// État lecture seule (fixtures MVP, mono-board).
// Le TSX reste la seule source de vérité ; ces fixtures seront branchées
// sur le worker compile + la file V1 dans les tickets suivants.

export interface BoardState {
  sessionId: string;
  board: string;
  ready: boolean;
  compile: { status: "ok" | "error"; errors: number; warnings: number };
  drc: { violations: number };
  protocolVersion: string;
}

export const PROTOCOL_VERSION = "2026-07-28";

export function getBoardState(sessionId = "default"): BoardState {
  return {
    sessionId,
    board: "nia-demo",
    ready: true,
    compile: { status: "ok", errors: 0, warnings: 0 },
    drc: { violations: 0 },
    protocolVersion: PROTOCOL_VERSION,
  };
}

export interface HierarchyPin {
  pin: string;
  net: string;
}

export interface HierarchyComponent {
  refdes: string;
  pkg: string;
  value: string;
  rotation: number;
  nets: string[];
  pins: HierarchyPin[];
}

export function getHierarchy() {
  return {
    board: "nia-demo",
    sessionId: "default",
    modules: [
      {
        name: "top",
        components: [
          {
            refdes: "R1",
            pkg: "0402",
            value: "10k",
            rotation: 0,
            nets: ["3V3", "GND"],
            pins: [
              { pin: "1", net: "3V3" },
              { pin: "2", net: "GND" },
            ],
          } satisfies HierarchyComponent,
          {
            refdes: "C1",
            pkg: "0603",
            value: "100nF",
            rotation: 90,
            nets: ["3V3", "GND"],
            pins: [
              { pin: "1", net: "3V3" },
              { pin: "2", net: "GND" },
            ],
          } satisfies HierarchyComponent,
        ],
      },
    ],
  };
}

export interface LogEntry {
  seq: number;
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  source: "compile" | "erc" | "drc" | "export" | "server";
  message: string;
}

const SEED_LOGS: LogEntry[] = [
  { seq: 1, ts: "2026-11-01T00:00:01Z", level: "info", source: "server", message: "pcb-mcp prêt (lecture seule)" },
  { seq: 2, ts: "2026-11-01T00:00:02Z", level: "info", source: "compile", message: "compile ok : 0 erreur, 0 warning" },
  { seq: 3, ts: "2026-11-01T00:00:03Z", level: "warn", source: "drc", message: "drc : 0 violation" },
  { seq: 4, ts: "2026-11-01T00:00:04Z", level: "info", source: "erc", message: "erc : 0 erreur" },
  { seq: 5, ts: "2026-11-01T00:00:05Z", level: "error", source: "compile", message: "exemple : net flottant NC-1 (fixture)" },
];

export function readLogs(opts: { cursor?: string; limit?: number; level?: LogEntry["level"] }): {
  entries: LogEntry[];
  nextCursor: string;
  hasMore: boolean;
  newErrors: number;
} {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  let filtered = SEED_LOGS;
  if (opts.level) filtered = filtered.filter((e) => e.level === opts.level);
  let start = 0;
  if (opts.cursor) {
    const idx = filtered.findIndex((e) => String(e.seq) === opts.cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const entries = filtered.slice(start, start + limit);
  const last = entries.length > 0 ? entries[entries.length - 1]!.seq : (start > 0 ? Number(opts.cursor) || 0 : 0);
  const hasMore = start + limit < filtered.length;
  const newErrors = entries.filter((e) => e.level === "error").length;
  return { entries, nextCursor: String(last), hasMore, newErrors };
}
