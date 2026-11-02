// Store screenshots agent (ticket #15) : PNG base64 par source + lien preview locale.
// La WebView dépose les PNG via Tauri `save_screenshot` dans le même dossier
// (cache `niatscircuit/previews/`, override `PCB_MCP_PREVIEW_DIR` en tests) ;
// l'outil MCP `preview_screenshot` ne fait que lire — jamais d'image inventée.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PreviewSource = "schematic_2d" | "pcb_2d" | "pcb_3d";

export const PREVIEW_SOURCES: readonly PreviewSource[] = [
  "schematic_2d",
  "pcb_2d",
  "pcb_3d",
] as const;

const ALIASES: Record<string, PreviewSource> = {
  schematique_2d: "schematic_2d",
  schematic: "schematic_2d",
  schema: "schematic_2d",
  pcb: "pcb_2d",
  "3d": "pcb_3d",
};

export const OFFLINE_BANNER =
  "RÉSEAU REQUIS hors-ligne — CDN désactivé (disableCdnLoading) : preview figée sur la dernière compile locale, aucun circuit-json inventé.";

export const NO_GPU_FALLBACK =
  "Sans GPU (WebGPU rendering failed constaté au prototype) : screenshot pcb_2d/pcb_3d bascule sur fallback SVG/canvas 2D documenté, jamais d'image inventée.";

export function normalizePreviewSource(
  input: unknown,
): { ok: true; source: PreviewSource } | { ok: false; message: string } {
  const raw = typeof input === "string" ? input.trim() : "";
  if ((PREVIEW_SOURCES as readonly string[]).includes(raw)) {
    return { ok: true, source: raw as PreviewSource };
  }
  const alias = ALIASES[raw];
  if (alias) return { ok: true, source: alias };
  return {
    ok: false,
    message:
      `source screenshot inconnue "${raw}" (attendues : ${PREVIEW_SOURCES.join(", ")}, alias prototype "schematique_2d" accepté)`,
  };
}

/** Dossier partagé WebView ↔ sidecar. Override tests via `PCB_MCP_PREVIEW_DIR`. */
export function previewDir(): string {
  const override = (process.env.PCB_MCP_PREVIEW_DIR ?? "").trim();
  if (override) return override;
  return path.join(os.tmpdir(), "niatscircuit-previews");
}

export function previewFilePath(source: PreviewSource, dir?: string): string {
  return path.join(dir ?? previewDir(), `${source}.png`);
}

export function previewMetaPath(source: PreviewSource, dir?: string): string {
  return path.join(dir ?? previewDir(), `${source}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return null;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) {
    return null;
  }
  return { width, height };
}

export interface SavePreviewInput {
  source: string;
  dataUrl: string;
  width?: number;
  height?: number;
}

export interface SavedPreview {
  source: PreviewSource;
  bytes: number;
  width: number;
  height: number;
  path: string;
  previewUrl: string;
  updatedAt: string;
}

const PNG_PREFIX = "data:image/png;base64,";

export function savePreview(input: SavePreviewInput, dir?: string): SavedPreview {
  const norm = normalizePreviewSource(input.source);
  if (!norm.ok) throw new Error(norm.message);
  const source = norm.source;
  const targetDir = dir ?? previewDir();
  ensureDir(targetDir);
  if (typeof input.dataUrl !== "string" || !input.dataUrl.startsWith(PNG_PREFIX)) {
    throw new Error("screenshot attendu en PNG dataURL (data:image/png;base64,…) — jamais d'image inventée hors PNG");
  }
  const b64 = input.dataUrl.slice(PNG_PREFIX.length);
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    throw new Error("base64 PNG illisible");
  }
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    throw new Error("octets PNG invalides (magie PNG absente)");
  }
  let width = Math.trunc(input.width ?? 0);
  let height = Math.trunc(input.height ?? 0);
  if (!(width > 0 && height > 0)) {
    const dims = parsePngDimensions(buf);
    if (!dims) throw new Error("dimensions PNG illisibles et non fournies");
    width = dims.width;
    height = dims.height;
  }
  const filePath = previewFilePath(source, targetDir);
  fs.writeFileSync(filePath, buf);
  const updatedAt = new Date().toISOString();
  const previewUrl = pathToFileURL(filePath).href;
  const meta = { source, bytes: buf.length, width, height, updatedAt, previewUrl };
  fs.writeFileSync(previewMetaPath(source, targetDir), JSON.stringify(meta, null, 2));
  return { source, bytes: buf.length, width, height, path: filePath, previewUrl, updatedAt };
}

export interface ReadPreviewResult {
  found: boolean;
  source: PreviewSource | string;
  dataUrl: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  previewUrl: string | null;
  updatedAt: string | null;
  banner: string | null;
  message: string | null;
  errors: number;
  warnings: number;
}

export function readPreview(
  sourceInput: unknown,
  opts?: { dir?: string; disableCdnLoading?: boolean },
): ReadPreviewResult {
  const banner = opts?.disableCdnLoading ? OFFLINE_BANNER : null;
  const norm = normalizePreviewSource(sourceInput);
  if (!norm.ok) {
    return {
      found: false,
      source: typeof sourceInput === "string" ? sourceInput : "",
      dataUrl: null,
      bytes: 0,
      width: null,
      height: null,
      previewUrl: null,
      updatedAt: null,
      banner,
      message: norm.message,
      errors: 1,
      warnings: 0,
    };
  }
  const source = norm.source;
  const targetDir = opts?.dir ?? previewDir();
  const filePath = previewFilePath(source, targetDir);
  if (!fs.existsSync(filePath)) {
    return {
      found: false,
      source,
      dataUrl: null,
      bytes: 0,
      width: null,
      height: null,
      previewUrl: null,
      updatedAt: null,
      banner,
      message:
        `aucun screenshot pour ${source} — ouvre l'app, affiche l'onglet ` +
        `${source === "schematic_2d" ? "Schéma" : source === "pcb_2d" ? "PCB" : "3D"} ` +
        `puis clique « Screenshot agent ». ${NO_GPU_FALLBACK}`,
      errors: 1,
      warnings: 0,
    };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return {
      found: false,
      source,
      dataUrl: null,
      bytes: 0,
      width: null,
      height: null,
      previewUrl: null,
      updatedAt: null,
      banner,
      message: `screenshot illisible pour ${source} : ${e instanceof Error ? e.message : String(e)}`,
      errors: 1,
      warnings: 0,
    };
  }
  let width: number | null = null;
  let height: number | null = null;
  let updatedAt: string | null = null;
  try {
    const metaRaw = fs.readFileSync(previewMetaPath(source, targetDir), "utf8");
    const meta = JSON.parse(metaRaw) as { width?: unknown; height?: unknown; updatedAt?: unknown };
    if (typeof meta.width === "number" && meta.width > 0) width = Math.trunc(meta.width);
    if (typeof meta.height === "number" && meta.height > 0) height = Math.trunc(meta.height);
    if (typeof meta.updatedAt === "string") updatedAt = meta.updatedAt;
  } catch {
    // Métadonnées absentes (dépôt manuel) : retombe sur l'en-tête PNG.
  }
  if (width === null || height === null) {
    const dims = parsePngDimensions(buf);
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  }
  return {
    found: true,
    source,
    dataUrl: `${PNG_PREFIX}${buf.toString("base64")}`,
    bytes: buf.length,
    width,
    height,
    previewUrl: pathToFileURL(filePath).href,
    updatedAt,
    banner,
    message: null,
    errors: 0,
    warnings: 0,
  };
}
