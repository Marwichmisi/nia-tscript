// Hôte sidecar T1 (#56) : réexporte le pur de tools-core/fab.ts et garde
// le hook de TEST `fabExportBaseDir` (`PCB_MCP_EXPORT_DIR`, jamais posé par
// le backend prod, non contrôlable via MCP).
import os from "node:os";
import path from "node:path";

export {
  sanitizeSegment,
  exportFab,
  writeFabArtifacts,
  type FabCounts,
  type FabOk,
  type FabErr,
  type ExportFabOptions,
  type FabArtifact,
} from "./tools-core/fab.js";

/** Dossier d'artefacts fab. Override tests via `PCB_MCP_EXPORT_DIR`.
 *  Hook de TEST (revue #37 item 4) : jamais posé par le backend prod, non
 *  contrôlable via MCP — SANS env, le handler `fab_export` résout dans
 *  `<projet>/exports/<basename>-<hash12>` (défense en profondeur). */
export function fabExportBaseDir(): string {
  const override = (process.env.PCB_MCP_EXPORT_DIR ?? "").trim();
  if (override) return override;
  return path.join(os.tmpdir(), "niatscircuit-exports");
}
