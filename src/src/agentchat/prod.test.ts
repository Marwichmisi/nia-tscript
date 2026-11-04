// Couture prod (US30) : le récapitulatif pré-envoi compte les VRAIES lignes.

import { describe, expect, test, vi } from "vitest";

// `../lib/agent` tire la chaîne compile (`@tscircuit/*`, pré-existant hors
// scope) : mockée ici, la couture sous test reçoit ses dépendances injectées.
vi.mock("../lib/agent", () => ({
  getAgentRouter: () => {
    throw new Error("routeur non injecté en test");
  },
}));

import { countMainLines, createBoardReader } from "./prod";

describe("countMainLines", () => {
  test("vide → 0", () => {
    expect(countMainLines("")).toBe(0);
  });

  test("compte les lignes (newline final non compté double)", () => {
    expect(countMainLines("a\nb\nc\n")).toBe(3);
    expect(countMainLines("a\nb\nc")).toBe(3);
    expect(countMainLines("une seule")).toBe(1);
  });
});

describe("createBoardReader (récapitulatif pré-envoi)", () => {
  test("mainLines = vraies lignes de main.tsx, pas 0", async () => {
    const read = createBoardReader({
      readMain: async () => ({ code: "a\nb\nc\nd\n" }),
      fetchState: async () => ({ text: '{"stats":{"total":7}}' }),
      fetchHierarchy: async () => ({ text: "board>top" }),
    });
    const snap = await read();
    expect(snap.mainLines).toBe(4);
    expect(snap.elements).toBe(7);
    expect(snap.summary).toContain("4");
  });

  test("main.tsx illisible → mainLines 0 + résumé dégradé explicite", async () => {
    const read = createBoardReader({
      readMain: async () => null,
      fetchState: async () => null,
      fetchHierarchy: async () => null,
    });
    const snap = await read();
    expect(snap.mainLines).toBe(0);
    expect(snap.summary).toMatch(/indisponible|dégradé/i);
  });
});
