// Coffre Conversation (US30) : Conversations chiffrées au repos, jamais de
// PI en clair dans le stockage.
//
// - AES-256-GCM (WebCrypto), IV 96 bits aléatoire par sauvegarde, enveloppe
//   JSON `{v:1, iv, ct}` (base64) sous la même clé `nia.agentchat.<projet>`.
// - Clé dérivée par Projet (PBKDF2 SHA-256, 120 000 itérations, sel fixe
//   versionné) depuis `nia-agentchat-v1:<projectPath>` : jamais persistée,
//   re-dérivée à chaque accès, isolée par Projet (un coffre ne s'ouvre pas
//   avec un autre chemin).
// - Migration : une valeur legacy en clair (JSON Conversation) est lue puis
//   REMPLACÉE par du chiffré à la première sauvegarde — aucune PI en clair
//   restante après migration.
// - Choix documenté (revue) : `src-tauri` étant gelé sauf `llm_models`, le
//   vault backend (AES-256-GCM, clé machine, `llm.rs`) ne peut pas stocker
//   les Conversations ; cet équivalent frontend testé chiffre au repos avec
//   une clé dérivée locale (pas de secret persisté, pas de PI en clair au
//   repos). Limite honnête : la dérivation étant déterministe et locale, un
//   attaquant avec accès disque + code source peut re-dériver — la barrière
//   réelle (vault backend + secret machine) suivra quand `src-tauri`
//   rouvrira. En attendant : dump du stockage = opaque (tests ci-contre).
// - `crypto.subtle` requis (Tauri : `https://tauri.localhost` = contexte
//   sécurisé ; dev `http://localhost` = trustworthy). Sans lui,
//   `isCryptoAvailable()` est faux et l'appelant dégrade en mémoire seule.

import {
  conversationKey,
  loadConversation,
  newConversation,
  saveConversation,
  type Conversation,
  type StorageLike,
} from "./store";

/** Stockage injecté (prod : `localStorage` ; tests : mémoire). */
export type EncryptedStorage = StorageLike;

const ENVELOPE_VERSION = 1;
const KDF_INFO = "nia-agentchat-v1:";
const KDF_SALT = "nia-agentchat-sel-v1";
const KDF_ITERATIONS = 120_000;

interface Envelope {
  v: number;
  iv: string;
  ct: string;
}

/** `false` si WebCrypto indisponible (jamais en Tauri/Node récents). */
export function isCryptoAvailable(): boolean {
  try {
    return (
      typeof globalThis.crypto !== "undefined" &&
      typeof globalThis.crypto.subtle !== "undefined" &&
      typeof globalThis.crypto.getRandomValues !== "undefined"
    );
  } catch {
    return false;
  }
}

function requireSubtle(): SubtleCrypto {
  if (!isCryptoAvailable()) {
    throw new Error("WebCrypto indisponible — conversations non persistées (mémoire seule)");
  }
  return globalThis.crypto.subtle;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64decode(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function conversationKeyFor(projectPath: string): Promise<CryptoKey> {
  const subtle = requireSubtle();
  const enc = new TextEncoder();
  const base = await subtle.importKey(
    "raw",
    enc.encode(`${KDF_INFO}${projectPath}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(KDF_SALT), iterations: KDF_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Chiffre un JSON Conversation en enveloppe opaque (jamais de PI en clair). */
export async function encryptConversation(projectPath: string, json: string): Promise<string> {
  const subtle = requireSubtle();
  const key = await conversationKeyFor(projectPath);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json));
  const envelope: Envelope = { v: ENVELOPE_VERSION, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
  return JSON.stringify(envelope);
}

/** Déchiffre une enveloppe (mauvais Projet ou altération → throw). */
export async function decryptConversation(projectPath: string, envelope: string): Promise<string> {
  const subtle = requireSubtle();
  const parsed = JSON.parse(envelope) as Partial<Envelope>;
  if (!parsed || parsed.v !== ENVELOPE_VERSION || typeof parsed.iv !== "string" || typeof parsed.ct !== "string") {
    throw new Error("enveloppe Conversation illisible — régénérée neuve");
  }
  const key = await conversationKeyFor(projectPath);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(parsed.iv) },
    key,
    b64decode(parsed.ct),
  );
  return new TextDecoder().decode(plain);
}

/** Persiste la Conversation CHIFFRÉE (remplace toute valeur legacy en clair). */
export async function saveConversationEncrypted(
  storage: EncryptedStorage,
  projectPath: string,
  conv: Conversation,
): Promise<void> {
  const json = JSON.stringify({
    ...conv,
    projectPath,
    updatedAt: new Date().toISOString(),
  });
  storage.setItem(conversationKey(projectPath), await encryptConversation(projectPath, json));
}

/**
 * Charge la Conversation : enveloppe chiffrée d'abord, clair legacy ensuite
 * (migration), Conversation neuve sinon. Jamais de throw.
 */
export async function loadConversationEncrypted(
  storage: EncryptedStorage,
  projectPath: string,
  model: string,
): Promise<Conversation> {
  const raw = storage.getItem(conversationKey(projectPath));
  if (raw) {
    try {
      const json = await decryptConversation(projectPath, raw);
      const parsed = JSON.parse(json) as Partial<Conversation>;
      if (parsed && Array.isArray(parsed.messages)) {
        const loaded = loadConversation(
          { getItem: () => json, setItem: () => undefined, removeItem: () => undefined },
          projectPath,
        );
        if (!loaded.model) loaded.model = model;
        return loaded;
      }
    } catch {
      // Enveloppe illisible : tente le clair legacy, sinon Conversation neuve.
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Conversation>;
      if (parsed && Array.isArray(parsed.messages)) {
        // Clair legacy : lu (puis rechiffré par l'appelant à la sauvegarde).
        return loadConversation(storage, projectPath);
      }
    } catch {
      // JSON illisible : Conversation neuve ci-dessous.
    }
  }
  return newConversation(projectPath, model);
}

export { loadConversation, newConversation, saveConversation };
