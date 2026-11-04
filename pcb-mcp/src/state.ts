// État lecture seule (fixtures MVP, mono-board) + store TSX write-through (#12).
// HÔTE T1 (#56) : la mémoire pure vit dans tools-core/store.ts (singleton
// ci-dessous, même objet partagé) ; ce module garde la SEULE résolution
// Projet (lockfile → nom de board via `currentProjectPath`, injectée au cœur
// comme paramètre). Le TSX reste la seule source de vérité.
import { BOARD_CODE } from "./tools-core/board.js";
import path from "node:path";
import { currentProjectPath } from "./project.js";
import {
  createMemoryStore,
  getHierarchy as getHierarchyCore,
  PROTOCOL_VERSION,
  type BoardState,
  type HierarchyComponent,
  type HierarchyPin,
  type LogEntry,
} from "./tools-core/store.js";

export type { BoardState, HierarchyComponent, HierarchyPin, LogEntry };
export { PROTOCOL_VERSION };

const store = createMemoryStore(BOARD_CODE);

/** Singleton mémoire partagé (hôte : mêmes effets injectés au cœur). */
export function getSharedStore(): ReturnType<typeof createMemoryStore> {
  return store;
}

export function projectBoardName(): string {
  const proj = currentProjectPath();
  if (!proj) return "board";
  const base = path.basename(proj);
  return base || "board";
}

export function getBoardState(sessionId = "default"): BoardState {
  return store.getBoardState(projectBoardName(), sessionId);
}

export function getHierarchy() {
  // T2 I10 : dynamique depuis le TSX courant (miroir disque), board isolé
  // au Projet ouvert (basename, jamais de lecture hors Projet).
  return getHierarchyCore(projectBoardName(), "default", store.getCode());
}

/** Remet le store mémoire à la fixture (isolation des tests).
 *  Ne crée JAMAIS de Projet sur disque (ticket #38) : sans Projet ouvert
 *  explicite, les outils gated répondent le vrai `NO_PROJECT_OPEN`
 *  (fini la fixture démo masquante). Les suites qui ont besoin d'un Projet
 *  l'ouvrent explicitement (cf. `pcb-mcp/test/helpers.ts`). */
export function resetStoreForTests(): void {
  store.reset();
}

export function getCode(): string {
  return store.getCode();
}

/** Écrit le TSX courant (write-through via `code_patch`). */
export function setCode(code: string): void {
  store.setCode(code);
}

export function setLastCompile(status: BoardState["compile"]): void {
  store.setLastCompile(status);
}

/** Dernier compte de violations DRC/checks (reflet `pcb_state.drc`). */
export function setDrcViolations(n: number): void {
  store.setDrcViolations(n);
}

/** Snapshot atomique pour `batch_execute` (#16) : code + compile + drc. */
export function snapshotStore(): {
  code: string;
  compile: BoardState["compile"] | null;
  drc: number;
} {
  return store.snapshot();
}

/** Restaure un snapshot (rollback fichier + live, état inchangé). */
export function restoreStore(snap: {
  code: string;
  compile: BoardState["compile"] | null;
  drc: number;
}): void {
  store.restore(snap);
}

export function appendLog(
  level: LogEntry["level"],
  source: LogEntry["source"],
  message: string,
): LogEntry {
  return store.appendLog(level, source, message);
}

export function readLogs(opts: { cursor?: string; limit?: number; level?: LogEntry["level"] }): {
  entries: LogEntry[];
  nextCursor: string;
  hasMore: boolean;
  newErrors: number;
} {
  return store.readLogs(opts);
}
