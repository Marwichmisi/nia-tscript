// Protocole de lot (pur, testé) : le backend T4 (`llm_complete`) est un
// appel texte seul sans tool-calling natif (`src-tauri` intouchable en T6).
// Le tool-calling est donc émulé au niveau prompt : le modèle émet UN bloc
// clôturé ```batch_execute {json} que le wrapper convertit en tool-call SDK
// (schéma Zod validé côté SDK). Prêt à migrer vers des tools natifs quand
// une commande backend dédiée existera — voir en-tête de `tauriModel.ts`.

import { describe, expect, test } from "vitest";
import { extractBatchFence, hasBatchFence, stripBatchFence } from "./fence";

describe("protocole de lot", () => {
  test("sans bloc → pas de lot (réponse texte seule)", () => {
    expect(hasBatchFence("Bonjour, voici la doc.")).toBe(false);
    expect(extractBatchFence("Bonjour")).toBe(null);
    expect(stripBatchFence("Bonjour")).toBe("Bonjour");
  });

  test("bloc extrait et retiré du texte narré", () => {
    const text =
      'Je propose ce lot :\n```batch_execute\n{"operations": [{"kind": "move", "refdes": "R1", "x": 1, "y": 2}]}\n```\nDis-moi si ok.';
    expect(hasBatchFence(text)).toBe(true);
    const fenced = extractBatchFence(text);
    expect(fenced).toContain('"kind": "move"');
    const stripped = stripBatchFence(text);
    expect(stripped).toContain("Je propose ce lot");
    expect(stripped).not.toContain("batch_execute");
  });

  test("JSON invalide → ignoré (jamais de throw)", () => {
    expect(extractBatchFence("```batch_execute\n{pas json\n```")).toBe(null);
  });

  test("plusieurs blocs → premier seul (1 approval = 1 lot)", () => {
    const text =
      '```batch_execute\n{"operations": []}\n```\n```batch_execute\n{"operations": []}\n```';
    expect(extractBatchFence(text)).toBe('{"operations": []}');
    expect(stripBatchFence(text)).not.toContain("batch_execute");
  });
});
