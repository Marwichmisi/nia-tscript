// Couture S1 (sélecteur) : repli codé conservé, liste live via `llm_models`.

import { describe, expect, test, vi } from "vitest";
import { DEFAULT_MODEL_ID, FALLBACK_MODELS, listModels, loadModelList, supportsToolCalling } from "./models";

describe("listModels (repli codé)", () => {
  test("repli : modèle par défaut seul, fallback vrai", () => {
    expect(listModels()).toEqual({ models: [DEFAULT_MODEL_ID], fallback: true });
    expect(FALLBACK_MODELS).toContain("muse-spark-1.3");
  });
});

describe("loadModelList (live `llm_models`)", () => {
  test("live non vide → modèles live, fallback faux", async () => {
    const out = await loadModelList(async () => ["muse-spark-1.3", "muse-spark-1.2"]);
    expect(out).toEqual({ models: ["muse-spark-1.3", "muse-spark-1.2"], fallback: false });
  });

  test("live vide → repli codé conservé", async () => {
    const out = await loadModelList(async () => []);
    expect(out.fallback).toBe(true);
    expect(out.models).toContain(DEFAULT_MODEL_ID);
  });

  test("erreur backend (pas de Projet, pas de clé) → repli codé", async () => {
    const out = await loadModelList(() => Promise.reject(new Error("NO_PROJECT_OPEN")));
    expect(out.fallback).toBe(true);
    expect(out.models).toContain(DEFAULT_MODEL_ID);
  });

  test("doublons et vides filtrés, ordre préservé", async () => {
    const fetchLive = vi.fn(async () => ["b", "  ", "a", "b"]);
    const out = await loadModelList(fetchLive);
    expect(out).toEqual({ models: ["b", "a"], fallback: false });
  });
});

describe("supportsToolCalling (US10)", () => {
  test("famille Meta muse-spark-* → lot supporté", () => {
    expect(supportsToolCalling("muse-spark-1.3")).toBe(true);
    expect(supportsToolCalling(DEFAULT_MODEL_ID)).toBe(true);
  });

  test("tout autre identifiant (ex. local Ollama) → texte seul + bandeau", () => {
    expect(supportsToolCalling("llama3")).toBe(false);
    expect(supportsToolCalling("")).toBe(false);
  });
});
