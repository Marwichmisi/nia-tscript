// @nia-tscircuit/mcp-bridge — lib pure (testable sans I/O réseau).
// Le runtime fin (bridge.mjs) importe ces helpers ; aucune log ici.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROTOCOL_DEFAULT = "2026-07-28";
export const LOG_PREFIX = "[bridge]";
export const APP_CLOSED_MESSAGE =
  "NIA studio fermé : ouvre l'app Tauri puis reconnecte (aucun headless au MVP).";

/** Chemin du lockfile `mcp.json` (même sémantique que `dirs::cache_dir`). */
export function defaultLockfilePath(
  opts = {},
) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? os.homedir();
  if (env.NIATSCIRCUIT_MCP_LOCK) return env.NIATSCIRCUIT_MCP_LOCK;
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "niatscircuit", "mcp.json");
  }
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "niatscircuit", "mcp.json");
  }
  const base = env.XDG_CACHE_HOME || path.join(home, ".cache");
  return path.join(base, "niatscircuit", "mcp.json");
}

/** Version protocole à mettre dans le header : _meta > params.initialize > lockfile. */
export function protocolVersionForMessage(msg, fallback) {
  const meta = msg?.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof meta === "string" && meta.length > 0) return meta;
  const pv = msg?.params?.protocolVersion;
  if (typeof pv === "string" && pv.length > 0) return pv;
  return fallback ?? PROTOCOL_DEFAULT;
}

/**
 * Headers du POST relayé (noms insensibles à la casse, valeurs sensibles).
 * Règle : les headers `Mcp-*` sont des miroirs des champs body — on ne les
 * envoie que si le body porte déjà l'enveloppe moderne (`_meta`), sinon le
 * serveur rejette en -32602 (le vrai client SDK stdio n'envoie pas `_meta`,
 * le serveur sert alors en legacy stateless). Seule exception : `initialize`
 * legacy (header version = params.protocolVersion, skip côté serveur).
 */
export function buildForwardHeaders(msg, lock) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${lock?.token ?? ""}`,
  };
  const metaVer = msg?.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof metaVer === "string" && metaVer.length > 0) {
    headers["mcp-protocol-version"] = metaVer;
    headers["mcp-method"] = String(msg?.method ?? "");
    const name = msg?.params?.name ?? msg?.params?.uri;
    if (typeof name === "string" && name.length > 0) headers["mcp-name"] = name;
    return headers;
  }
  if (msg?.method === "initialize" && typeof msg?.params?.protocolVersion === "string") {
    // Handshake legacy : le header version n'est envoyé que pour une version
    // legacy (2024/2025-*). Une version moderne SANS enveloppe `_meta` ne doit
    // pas être mise en header : le serveur la rejetterait en -32020, alors
    // qu'il négocie en legacy sans headers.
    if (isLegacyProtocolVersion(msg.params.protocolVersion)) {
      headers["mcp-protocol-version"] = msg.params.protocolVersion;
      headers["mcp-method"] = "initialize";
    }
  }
  return headers;
}

/** Versions pré-2026 : handshake `initialize` legacy (négociation dans le body). */
export function isLegacyProtocolVersion(v) {
  return typeof v === "string" && /^202[45]-/.test(v);
}

/** Normalise la réponse HTTP en lignes stdout (JSON direct ou SSE `data:`). */
export function extractResponseLines(contentType, bodyText) {
  const text = (bodyText ?? "").trim();
  if (!text) return [];
  if ((contentType ?? "").includes("text/event-stream")) {
    const out = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      out.push(data);
    }
    return out;
  }
  return [text];
}

/** Erreur JSON-RPC -32000 « ouvre l'app » (jamais de headless au MVP). */
export function appClosedError(id, url) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32000,
      message: APP_CLOSED_MESSAGE,
      ...(url ? { data: { url } } : {}),
    },
  });
}

/** Notification JSON-RPC : pas de `id` ⇒ aucune réponse sur stdout. */
export function isNotification(msg) {
  return msg != null && typeof msg === "object" && !("id" in msg);
}

/** Lit + valide le lockfile. Throw si absent/invalide (le runtime mappe en -32000). */
export function readLockfileSync(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (e) {
    throw new Error(`${LOG_PREFIX} lockfile illisible ${lockPath} : ${e?.message ?? e}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${LOG_PREFIX} lockfile JSON invalide ${lockPath}`);
  }
  const url = data?.url;
  const token = data?.token;
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) {
    throw new Error(`${LOG_PREFIX} lockfile url non-locale ou invalide : ${String(url)}`);
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`${LOG_PREFIX} lockfile token manquant`);
  }
  const protocolVersion =
    typeof data?.protocolVersion === "string" && data.protocolVersion.length > 0
      ? data.protocolVersion
      : PROTOCOL_DEFAULT;
  return { url, token, protocolVersion };
}
