// Couture S2 (store conversations) : persistance par Projet, compaction à
// 80 %, bouton Neuve. Zéro réseau, zéro clé.

import { describe, expect, test } from "vitest";
import {
  compactConversation,
  estimateTokens,
  loadConversation,
  newConversation,
  saveConversation,
  type ChatMessage,
  type Conversation,
  type StorageLike,
} from "./store";

function memStorage(seed: Record<string, string> = {}): StorageLike {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

const PROJET = "/projets/carte-demo";

function msg(role: ChatMessage["role"], text: string, model?: string): ChatMessage {
  return { id: `${role}-${text.slice(0, 8)}`, role, text, model };
}

describe("store conversations", () => {
  test("conversation vide par défaut pour un Projet, isolée par Projet", () => {
    const s = memStorage();
    const a = loadConversation(s, PROJET);
    expect(a.messages).toEqual([]);
    saveConversation(s, PROJET, { ...a, messages: [msg("user", "bonjour")] });
    expect(loadConversation(s, PROJET).messages).toHaveLength(1);
    expect(loadConversation(s, "/projets/autre").messages).toEqual([]);
  });

  test("Neuve repart d'un contexte neuf (même Projet)", () => {
    const s = memStorage();
    const pleine: Conversation = {
      version: 1,
      projectPath: PROJET,
      model: "muse-spark-1.3",
      mode: "manuel",
      consent: true,
      messages: [msg("user", "déplace R1"), msg("assistant", "ok", "muse-spark-1.3")],
      updatedAt: "x",
    };
    saveConversation(s, PROJET, pleine);
    const neuve = newConversation(PROJET, "muse-spark-1.3");
    saveConversation(s, PROJET, neuve);
    const relue = loadConversation(s, PROJET);
    expect(relue.messages).toEqual([]);
    expect(relue.model).toBe("muse-spark-1.3");
  });

  test("estimation ≈ caractères / 4, jamais nulle sur texte non vide", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("compaction < 80 % : historique inchangé", () => {
    const conv: Conversation = {
      version: 1,
      projectPath: PROJET,
      model: "muse-spark-1.3",
      mode: "manuel",
      consent: true,
      messages: [msg("user", "salut"), msg("assistant", "bonjour", "muse-spark-1.3")],
      updatedAt: "x",
    };
    const out = compactConversation(conv, 100_000);
    expect(out.compacted).toBe(false);
    expect(out.conversation.messages).toHaveLength(2);
  });

  test("compaction ≥ 80 % : résumé + derniers messages, sous le seuil", () => {
    const big = "déplace R1 de 2mm vers le haut. ".repeat(400); // ~13 600 car.
    const conv: Conversation = {
      version: 1,
      projectPath: PROJET,
      model: "muse-spark-1.3",
      mode: "manuel",
      consent: true,
      messages: [
        msg("user", big),
        msg("assistant", big, "muse-spark-1.3"),
        msg("user", "puis route"),
        msg("assistant", "lot appliqué", "muse-spark-1.3"),
      ],
      updatedAt: "x",
    };
    const out = compactConversation(conv, 1_000); // seuil bas forcé en test
    expect(out.compacted).toBe(true);
    const textes = out.conversation.messages.map((m) => m.text).join("\n");
    expect(textes).toContain("puis route");
    expect(estimateTokens(textes)).toBeLessThan(1_000);
    expect(out.conversation.messages[0]!.role).toBe("system");
  });

  test("corrompu → conversation vide (jamais de throw)", () => {
    const s = memStorage({ "nia.agentchat./p": "}{ pas du json" });
    expect(loadConversation(s, "/p").messages).toEqual([]);
  });
});
