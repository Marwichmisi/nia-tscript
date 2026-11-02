// Exports fab V1 — ticket #17 (spec #8, décision carte #6).
// V1 = gerbers + PnP + BOM + kicad_zip silencieux (STEP/GLB → V2).
// Libs pures offline-first (même moteur que la compile, pas de binaire
// `tsci` — finding §10 phase 1 lib seule) :
//   - circuit-json-to-gerber 0.0.122 → RS-274X + Excellon.
//   - circuit-json-to-bom-csv 0.0.27 → BOM CSV (R1/R2/U1…).
//   - circuit-json-to-pnp-csv 0.0.21 → pick-and-place CSV.
//   - circuit-json-to-kicad 0.0.262 → .kicad_pcb + .kicad_sch + .kicad_pro.
//   - jszip 3.10.2 → kicad_zip + fab_upload.zip (JLCPCB).
// Ce module est pur (aucune I/O) : l'écriture disque + file:// est faite par
// l'appelant (outil MCP `fab_export`), comme preview.ts sépare save/read.
import { convertCircuitJsonToGerberFiles } from "circuit-json-to-gerber";
import {
  convertBomRowsToCsv,
  convertCircuitJsonToBomRows,
} from "circuit-json-to-bom-csv";
import { convertCircuitJsonToPickAndPlaceCsv } from "circuit-json-to-pnp-csv";
import {
  CircuitJsonToKicadPcbConverter,
  CircuitJsonToKicadProConverter,
  CircuitJsonToKicadSchConverter,
} from "circuit-json-to-kicad";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

/** Segment de chemin sûr (session, projet). */
export function sanitizeSegment(s: string): string {
  const t = (s ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return t || "default";
}

/** Dossier d'artefacts fab. Override tests via `PCB_MCP_EXPORT_DIR`. */
export function fabExportBaseDir(): string {
  const override = (process.env.PCB_MCP_EXPORT_DIR ?? "").trim();
  if (override) return override;
  return path.join(os.tmpdir(), "niatscircuit-exports");
}

export interface FabCounts {
  gerberFiles: number;
  bomRows: number;
  pnpRows: number;
}

export interface FabOk {
  ok: true;
  projectName: string;
  counts: FabCounts;
  gerberNames: string[];
  gerberFiles: Record<string, string>;
  /** Premières lignes de F_Cu (preuve RS-274X sans inline tout le fichier). */
  gerberPreview: string;
  bomCsv: string;
  pnpCsv: string;
  kicadPcb: string;
  kicadSch: string;
  kicadPro: string;
  kicadPcbPreview: string;
  kicadZipBase64: string;
  kicadZipBytes: number;
  fabZipBase64: string;
  fabZipBytes: number;
}

export interface FabErr {
  ok: false;
  message: string;
}

export interface ExportFabOptions {
  projectName?: string;
}

function sanitizeProjectName(name: string): string {
  const t = sanitizeSegment(name);
  return t === "default" ? "nia-demo" : t;
}

/** Exports fab V1 depuis un circuit-json déjà compilé. Rien d'inventé. */
export async function exportFab(
  circuitJson: unknown[],
  opts?: ExportFabOptions,
): Promise<FabOk | FabErr> {
  const projectName = sanitizeProjectName(opts?.projectName ?? "nia-demo");
  if (!Array.isArray(circuitJson) || circuitJson.length === 0) {
    return { ok: false, message: "circuit-json vide : compilez d'abord via code_patch (aucun fichier fab inventé)" };
  }
  const cj = circuitJson as never[];
  let gerberFiles: Record<string, string>;
  try {
    gerberFiles = convertCircuitJsonToGerberFiles(cj) as Record<string, string>;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `export gerbers impossible : ${message.slice(0, 200)}` };
  }
  const gerberNames = Object.keys(gerberFiles).sort();
  if (gerberNames.length === 0) {
    return { ok: false, message: "export gerbers vide : circuit-json sans cuivre exploitable" };
  }
  let bomCsv: string;
  let bomRows = 0;
  try {
    const rows = await convertCircuitJsonToBomRows({ circuitJson: cj });
    bomRows = rows.length;
    bomCsv = convertBomRowsToCsv(rows);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `export BOM impossible : ${message.slice(0, 200)}` };
  }
  let pnpCsv: string;
  let pnpRows = 0;
  try {
    pnpCsv = convertCircuitJsonToPickAndPlaceCsv(cj);
    pnpRows = Math.max(0, pnpCsv.trim().split("\n").length - 1);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `export PnP impossible : ${message.slice(0, 200)}` };
  }
  let kicadPcb: string;
  let kicadSch: string;
  let kicadPro: string;
  try {
    const pcb = new CircuitJsonToKicadPcbConverter(cj);
    pcb.runUntilFinished();
    kicadPcb = pcb.getOutputString();
    const sch = new CircuitJsonToKicadSchConverter(cj);
    sch.runUntilFinished();
    kicadSch = sch.getOutputString();
    const pro = new CircuitJsonToKicadProConverter(cj);
    pro.runUntilFinished();
    kicadPro = pro.getOutputString();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `export KiCad impossible : ${message.slice(0, 200)}` };
  }
  const gerberPreview = String(gerberFiles["F_Cu.gbr"] ?? gerberFiles[gerberNames[0]!] ?? "").slice(0, 300);
  const kicadPcbPreview = kicadPcb.slice(0, 300);
  try {
    const kicadZip = new JSZip();
    kicadZip.file(`${projectName}.kicad_pcb`, kicadPcb);
    kicadZip.file(`${projectName}.kicad_sch`, kicadSch);
    kicadZip.file(`${projectName}.kicad_pro`, kicadPro);
    const kicadZipBase64 = await kicadZip.generateAsync({ type: "base64", compression: "DEFLATE" });
    const fabZip = new JSZip();
    for (const [name, content] of Object.entries(gerberFiles)) {
      fabZip.file(`gerbers/${name}`, content);
    }
    fabZip.file("bom.csv", bomCsv);
    fabZip.file("pick-and-place.csv", pnpCsv);
    const fabZipBase64 = await fabZip.generateAsync({ type: "base64", compression: "DEFLATE" });
    return {
      ok: true,
      projectName,
      counts: { gerberFiles: gerberNames.length, bomRows, pnpRows },
      gerberNames,
      gerberFiles,
      gerberPreview,
      bomCsv,
      pnpCsv,
      kicadPcb,
      kicadSch,
      kicadPro,
      kicadPcbPreview,
      kicadZipBase64,
      kicadZipBytes: Buffer.from(kicadZipBase64, "base64").length,
      fabZipBase64,
      fabZipBytes: Buffer.from(fabZipBase64, "base64").length,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `assemblage zips fab impossible : ${message.slice(0, 200)}` };
  }
}

export interface FabArtifact {
  name: string;
  bytes: number;
  previewUrl: string;
}

/** Écrit les artefacts fab sur disque (outil MCP). Retourne name/bytes/file://. */
export function writeFabArtifacts(
  out: FabOk,
  opts: { dir: string; writeFile: (path: string, content: string | Buffer) => void; toFileUrl: (path: string) => string; join: (...parts: string[]) => string },
): FabArtifact[] {
  const { dir, writeFile, toFileUrl, join } = opts;
  const artifacts: FabArtifact[] = [];
  const push = (name: string, content: string | Buffer) => {
    const full = join(dir, name);
    writeFile(full, content);
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.length;
    artifacts.push({ name, bytes, previewUrl: toFileUrl(full) });
  };
  for (const [name, content] of Object.entries(out.gerberFiles)) {
    push(`gerbers/${name}`, content);
  }
  push("bom.csv", out.bomCsv);
  push("pick-and-place.csv", out.pnpCsv);
  push(`${out.projectName}.kicad_pcb`, out.kicadPcb);
  push(`${out.projectName}.kicad_sch`, out.kicadSch);
  push(`${out.projectName}.kicad_pro`, out.kicadPro);
  push("kicad_project.zip", Buffer.from(out.kicadZipBase64, "base64"));
  push("fab_upload.zip", Buffer.from(out.fabZipBase64, "base64"));
  return artifacts;
}
