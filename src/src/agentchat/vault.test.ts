// Couture S2-chiffrée (US30) : Conversations chiffrées au repos (AES-256-GCM,
// WebCrypto), jamais de PI en clair dans le stockage. Migration du clair
// legacy transparente.

import { describe, expect, test } from "vitest";
import {
  decryptConversation,
  encryptConversation,
  isCryptoAvailable,
  loadConversationEncrypted,
  saveConversationEncrypted,
  type EncryptedStorage,
} from "./vault";
import { newConversation, type Conversation } from "./store";

function memStore(seed: Record<string, string> = {}): EncryptedStorage {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

const PROJET = "/projets/carte-demo";
const SECRET = "R1 déplacé de 2mm vers le connecteur J3 secret";

function convWithSecret(): Conversation {
  const c = newConversation(PROJET, "muse-spark-1.3");
  c.messages.push({ id: "u-1", role: "user", text: SECRET });
  return c;
}

describe("chiffrement au repos (US30)", () => {
  test("WebCrypto disponible dans cet environnement", () => {
    expect(isCryptoAvailable()).toBe(true);
  });

  test("roundtrip : le clair ne transite que chiffré", async () => {
    const s = memStore();
    const conv = convWithSecret();
    await saveConversationEncrypted(s, PROJET, conv);
    const raw = s.getItem(`nia.agentchat.${PROJET}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("J3 secret");
    const relue = await loadConversationEncrypted(s, PROJET, "muse-spark-1.3");
    expect(relue.messages.map((m) => m.text)).toContain(SECRET);
    expect(relue.id).toBe(conv.id);
  });

  test("deux sauvegardes → IV aléatoire (pas de fuite par comparaison)", async () => {
    const s = memStore();
    const conv = convWithSecret();
    await saveConversationEncrypted(s, PROJET, conv);
    const first = s.getItem(`nia.agentchat.${PROJET}`);
    await saveConversationEncrypted(s, PROJET, conv);
    const second = s.getItem(`nia.agentchat.${PROJET}`);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  test("projet différent → indéchiffrable (isolement par Projet)", async () => {
    const s = memStore();
    await saveConversationEncrypted(s, PROJET, convWithSecret());
    const raw = s.getItem(`nia.agentchat.${PROJET}`)!;
    await expect(decryptConversation("/projets/autre", raw)).rejects.toThrow();
  });

  test("enveloppe corrompue → Conversation neuve, jamais de throw", async () => {
    const s = memStore({ [`nia.agentchat.${PROJET}`]: "}{ pas du json chiffré" });
    const relue = await loadConversationEncrypted(s, PROJET, "muse-spark-1.3");
    expect(relue.messages).toEqual([]);
    expect(relue.projectPath).toBe(PROJET);
  });

  test("migration : clair legacy lu puis rechiffré (aucune PI en clair restante)", async () => {
    const legacy = JSON.stringify({ ...convWithSecret(), version: 1 });
    const s = memStore({ [`nia.agentchat.${PROJET}`]: legacy });
    const relue = await loadConversationEncrypted(s, PROJET, "muse-spark-1.3");
    expect(relue.messages.map((m) => m.text)).toContain(SECRET);
    await saveConversationEncrypted(s, PROJET, relue);
    expect(s.getItem(`nia.agentchat.${PROJET}`)).not.toContain(SECRET);
  });

  test("enveloppe brute : ni PI ni clé dans le stockage", async () => {
    const s = memStore();
    await saveConversationEncrypted(s, PROJET, convWithSecret());
    const raw = s.getItem(`nia.agentchat.${PROJET}`)!;
    const parsed = JSON.parse(raw) as { v: number; iv: string; ct: string };
    expect(parsed.v).toBe(1);
    expect(typeof parsed.iv).toBe("string");
    expect(typeof parsed.ct).toBe("string");
    expect(raw).not.toMatch(/muse-spark/);
    await expect(encryptConversation(PROJET, "x")).resolves.toMatch(/^\{/);
  });
});
