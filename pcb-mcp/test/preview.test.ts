// S-preview-pur — module preview.ts (frontière module, sans HTTP).
// Valeurs indépendantes : 1x1 PNG connu, jamais recalculé par le code sous test.
import { describe, test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizePreviewSource,
  previewFilePath,
  savePreview,
  readPreview,
  OFFLINE_BANNER,
  NO_GPU_FALLBACK,
} from "../src/preview";

// 1x1 PNG opaque (68 octets décodés) — source de vérité indépendante.
const PIXEL_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-preview-pur-"));
});

describe("S-preview-pur — store screenshot agent", () => {
  test("normalize accepte les 3 sources + alias prototype schematique_2d", () => {
    expect(normalizePreviewSource("schematic_2d")).toMatchObject({ ok: true });
    expect(normalizePreviewSource("pcb_2d")).toMatchObject({ ok: true });
    expect(normalizePreviewSource("pcb_3d")).toMatchObject({ ok: true });
    const alias = normalizePreviewSource("schematique_2d");
    expect(alias).toMatchObject({ ok: true, source: "schematic_2d" });
  });

  test("source inconnue → rejet exploitable", () => {
    const r = normalizePreviewSource("gerber_layer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/schematic_2d/);
  });

  test("save puis read → base64 + taille + lien preview locale", () => {
    const saved = savePreview(
      { source: "pcb_2d", dataUrl: PIXEL_1X1, width: 1, height: 1 },
      dir,
    );
    expect(saved.bytes).toBeGreaterThan(50);
    expect(saved.width).toBe(1);
    expect(saved.height).toBe(1);
    expect(saved.path).toContain("pcb_2d.png");
    expect(saved.previewUrl.startsWith("file://")).toBe(true);

    const read = readPreview("pcb_2d", { dir });
    expect(read.found).toBe(true);
    expect(read.dataUrl).toBe(PIXEL_1X1);
    expect(read.bytes).toBe(saved.bytes);
    expect(read.width).toBe(1);
    expect(read.height).toBe(1);
    expect(read.previewUrl).toBe(saved.previewUrl);
    expect(read.errors).toBe(0);
  });

  test("read sans fichier → message explicite, jamais d'image inventée", () => {
    const read = readPreview("schematic_2d", { dir });
    expect(read.found).toBe(false);
    expect(read.dataUrl).toBeNull();
    expect(read.previewUrl).toBeNull();
    expect(read.errors).toBe(1);
    expect(`${read.message ?? ""}`).toMatch(/ouvre l'app/);
  });

  test("dataUrl non-PNG → rejet, rien écrit", () => {
    expect(() =>
      savePreview({ source: "pcb_2d", dataUrl: "data:image/jpeg;base64,/9j/" }, dir),
    ).toThrow(/PNG/);
    expect(fs.existsSync(previewFilePath("pcb_2d", dir))).toBe(false);
  });

  test("bandeaux offline + no-GPU documentés", () => {
    expect(OFFLINE_BANNER).toMatch(/RÉSEAU|CDN/);
    expect(NO_GPU_FALLBACK).toMatch(/WebGPU|fallback/);
    const read = readPreview("pcb_3d", { dir, disableCdnLoading: true });
    expect(read.banner).toMatch(/CDN|RÉSEAU/);
  });
});
