// État mémoire pur (T1, #56) : store TSX write-through + logs + statuts.
// Extrait de `src/state.ts` sans changer la logique. Aucune I/O, aucun
// import node: — la résolution du Projet ouvert (`currentProjectPath` /
// lockfile) est EXCLUE du cœur : l'hôte (`src/state.ts`) injecte le nom de
// board résolu (`projectBoardName`) à `getBoardState`. Le TSX reste la seule
// source de vérité ; le store en mémoire est initialisé avec la fixture
// R1/R2+U1 du prototype et muté uniquement via `code_patch`.
import { BOARD_CODE } from "./board.js";

export interface BoardState {
  sessionId: string;
  board: string;
  ready: boolean;
  compile: { status: "ok" | "error"; errors: number; warnings: number };
  drc: { violations: number };
  protocolVersion: string;
}

export const PROTOCOL_VERSION = "2026-07-28";

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

export function getHierarchy(boardName = "board", sessionId = "default") {
  return {
    board: boardName,
    sessionId,
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

export interface StoreSnapshot {
  code: string;
  compile: BoardState["compile"] | null;
  drc: number;
}

/** Store mémoire mono-board : TSX courant + dernier statut compile + logs. */
export interface MemoryStore {
  getCode(): string;
  /** Écrit le TSX courant (write-through via `code_patch`). */
  setCode(code: string): void;
  setLastCompile(status: BoardState["compile"]): void;
  /** Dernier compte de violations DRC/checks (reflet `pcb_state.drc`). */
  setDrcViolations(n: number): void;
  getBoardState(boardName: string, sessionId?: string): BoardState;
  /** Snapshot atomique pour `batch_execute` (#16) : code + compile + drc. */
  snapshot(): StoreSnapshot;
  /** Restaure un snapshot (rollback fichier + live, état inchangé). */
  restore(snap: StoreSnapshot): void;
  appendLog(level: LogEntry["level"], source: LogEntry["source"], message: string): LogEntry;
  readLogs(opts: { cursor?: string; limit?: number; level?: LogEntry["level"] }): {
    entries: LogEntry[];
    nextCursor: string;
    hasMore: boolean;
    newErrors: number;
  };
  /** Remet le store à la fixture (isolation des tests). */
  reset(): void;
}

export function createMemoryStore(seedCode: string = BOARD_CODE): MemoryStore {
  const logs: LogEntry[] = [...SEED_LOGS];
  let nextSeq = SEED_LOGS.length + 1;
  let currentCode: string = seedCode;
  let lastCompile: BoardState["compile"] | null = null;
  let lastDrcViolations = 0;

  return {
    getCode(): string {
      return currentCode;
    },
    setCode(code: string): void {
      currentCode = code;
    },
    setLastCompile(status: BoardState["compile"]): void {
      lastCompile = status;
    },
    setDrcViolations(n: number): void {
      lastDrcViolations = n;
    },
    getBoardState(boardName: string, sessionId = "default"): BoardState {
      const compile = lastCompile ?? { status: "ok" as const, errors: 0, warnings: 0 };
      return {
        sessionId,
        board: boardName,
        ready: compile.status === "ok",
        compile,
        drc: { violations: lastDrcViolations },
        protocolVersion: PROTOCOL_VERSION,
      };
    },
    snapshot(): StoreSnapshot {
      return { code: currentCode, compile: lastCompile, drc: lastDrcViolations };
    },
    restore(snap: StoreSnapshot): void {
      currentCode = snap.code;
      lastCompile = snap.compile;
      lastDrcViolations = snap.drc;
    },
    appendLog(
      level: LogEntry["level"],
      source: LogEntry["source"],
      message: string,
    ): LogEntry {
      const entry: LogEntry = {
        seq: nextSeq++,
        ts: new Date().toISOString(),
        level,
        source,
        message,
      };
      logs.push(entry);
      return entry;
    },
    readLogs(opts: { cursor?: string; limit?: number; level?: LogEntry["level"] }): {
      entries: LogEntry[];
      nextCursor: string;
      hasMore: boolean;
      newErrors: number;
    } {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
      let filtered = logs;
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
    },
    reset(): void {
      logs.length = 0;
      logs.push(...SEED_LOGS);
      nextSeq = SEED_LOGS.length + 1;
      currentCode = seedCode;
      lastCompile = null;
      lastDrcViolations = 0;
    },
  };
}
