// Captures agent : partie pure (T1, #56) — types, slugs, constantes, normalisation.
// Extrait de `src/preview.ts` sans changer la logique. Aucun import node: —
// la lecture/écriture disque (`readPreview`, `savePreview`) reste côté hôte.
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

/** Nom de capture agent (Q10) : slug `a-z0-9-_`, max 32, vide → null. */
export function sanitizePreviewName(name?: unknown): string | null {
  if (name === undefined || name === null) return null;
  const raw = String(name).trim();
  if (!raw) return null;
  let slug = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32)
    .replace(/^[-_]+|[-_]+$/g, "");
  while (slug.includes("--")) slug = slug.replace(/--/g, "-");
  return slug || null;
}

/** Plafond capture (ticket #42) : refus au-delà de 20 Mo. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** Plafond captures par dossier (ticket #42) : 50 fichiers, éviction LRU. */
export const PREVIEW_MAX_FILES = 50;

export interface ReadPreviewResult {
  found: boolean;
  source: PreviewSource | string;
  name: string | null;
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

/** Lecteur de captures injecté par l'hôte (sidecar : disque via `src/preview.ts`). */
export type PreviewReader = (
  sourceInput: unknown,
  opts?: { dir?: string; disableCdnLoading?: boolean; name?: string | null },
) => ReadPreviewResult;
