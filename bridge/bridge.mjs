#!/usr/bin/env node
// @nia-tscircuit/mcp-bridge — thin stdio ↔ HTTP (ticket #11, ~120 lignes).
// Contrat : stdin = MCP pur (lignes JSON-RPC) ; chaque ligne ⇒ POST ver lock.url
// + Authorization Bearer ; réponse (JSON ou SSE `data:`) ⇒ une ligne sur stdout.
// Logs ⇒ stderr préfixé `[bridge]` uniquement ; stdout jamais polluée.
// Jamais de headless : probe KO ⇒ erreur JSON-RPC -32000 « ouvre l'app ».
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_CLOSED_MESSAGE,
  LOG_PREFIX,
  appClosedError,
  buildForwardHeaders,
  defaultLockfilePath,
  extractResponseLines,
  isNotification,
  readLockfileSync,
} from "./lib.mjs";

const PROBE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: "nia-bridge-probe",
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "nia-bridge-probe", version: "0.1.0" },
  },
});

function log(...args) {
  console.error(LOG_PREFIX, ...args);
}

async function probeLock(lock) {
  try {
    const res = await fetch(lock.url, {
      method: "POST",
      headers: buildForwardHeaders(
        { jsonrpc: "2.0", id: "nia-bridge-probe", method: "initialize", params: { protocolVersion: "2025-06-18" } },
        lock,
      ),
      body: PROBE_BODY,
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const text = await res.text();
    return text.includes("serverInfo") || text.includes('"ready":true');
  } catch {
    return false;
  }
}

function parseLine(line) {
  try {
    return { msg: JSON.parse(line) };
  } catch {
    return { parseError: true };
  }
}

async function forwardOnce(rawLine, lock) {
  const headers = (() => {
    try {
      const msg = JSON.parse(rawLine);
      return buildForwardHeaders(msg, lock);
    } catch {
      return null;
    }
  })();
  const res = await fetch(lock.url, {
    method: "POST",
    // Ligne non-JSON : rien à miroiter ; style legacy sans headers Mcp-*
    // (même règle que buildForwardHeaders sans _meta).
    headers: headers ?? {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${lock.token}`,
    },
    body: rawLine,
    signal: AbortSignal.timeout(30000),
  });
  return res;
}

async function handleLine(rawLine, state) {
  const { msg, parseError } = parseLine(rawLine);
  if (parseError) {
    log("ligne non-JSON ignorée (stdout préservée)");
    return;
  }
  if (msg === null || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    if (msg !== null && typeof msg === "object" && !isNotification(msg)) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Invalid Request" } })}\n`,
      );
    }
    return;
  }
  const notification = isNotification(msg);

  if (state.degraded) {
    // L'app a peut-être rouvert depuis (lockfile écrit au boot après
    // readiness) : relire + re-prober une fois avant de conclure -32000.
    try {
      state.lock = readLockfileSync(state.lockPath);
    } catch {
      // Pas de lockfile lisible : on reste dégradé.
    }
    if (state.lock && (await probeLock(state.lock))) {
      state.degraded = false;
      log("studio de nouveau joignable, reprise du forward");
    } else {
      if (!notification) process.stdout.write(`${appClosedError(msg.id, state.lock?.url)}\n`);
      return;
    }
  }

  try {
    let res = await forwardOnce(rawLine, state.lock);
    if (res.status === 401) {
      // Token peut-être tourné (app relancée) : relire le lockfile une fois.
      try {
        const fresh = readLockfileSync(state.lockPath);
        if (fresh.token !== state.lock.token) {
          state.lock = fresh;
          res = await forwardOnce(rawLine, state.lock);
        }
      } catch {
        // Lecture KO : on retombe sur l'erreur générique ci-dessous.
      }
    }
    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (!res.ok) {
      // Erreurs protocole fines (-32020/-32022/-32601) : relayer telles quelles.
      const trimmed = body.trim();
      if (trimmed.startsWith("{") && trimmed.includes('"error"')) {
        if (!notification) process.stdout.write(`${trimmed}\n`);
        return;
      }
      if (!notification) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id ?? null,
            error: { code: -32000, message: `${APP_CLOSED_MESSAGE} (HTTP ${res.status})` },
          })}\n`,
        );
      }
      return;
    }
    if (notification) return; // 202 accepté : aucune réponse.
    const lines = extractResponseLines(contentType, body);
    if (lines.length === 0) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: "réponse vide du studio" } })}\n`,
      );
      return;
    }
    for (const line of lines) process.stdout.write(`${line.trim()}\n`);
  } catch (e) {
    // Réseau coupé (app fermée entre-temps) : re-probe une fois, sinon -32000.
    const alive = await probeLock(state.lock);
    if (!alive) {
      state.degraded = true;
      log(`studio injoignable (${e?.cause?.code ?? e?.message ?? e}), passage en mode -32000`);
      if (!notification) process.stdout.write(`${appClosedError(msg.id, state.lock?.url)}\n`);
      return;
    }
    log(`forward KO : ${e?.message ?? e}`);
    if (!notification) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: "forward bridge KO" } })}\n`,
      );
    }
  }
}

async function main() {
  const lockPath = defaultLockfilePath();
  const state = { lockPath, lock: null, degraded: false };
  try {
    state.lock = readLockfileSync(lockPath);
  } catch (e) {
    state.degraded = true;
    log(`${e?.message ?? e}`);
    log("aucun lockfile valide : réponses -32000 jusqu'au redémarrage (relance le bridge après avoir ouvert l'app)");
  }
  if (!state.degraded) {
    const ok = await probeLock(state.lock);
    if (!ok) {
      state.degraded = true;
      const url = state.lock.url;
      log(`probe KO sur ${url} : ${APP_CLOSED_MESSAGE}`);
    } else {
      log(`attaché à ${state.lock.url} (multi-client OK, même état)`);
    }
  }

  let buf = "";
  let pending = 0;
  let stdinEnded = false;
  const maybeExit = () => {
    if (stdinEnded && pending === 0) process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      pending++;
      void Promise.resolve(handleLine(line, state)).finally(() => {
        pending--;
        maybeExit();
      });
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    // Garde-fou : jamais de bridge fantôme, même si une requête reste coincée.
    setTimeout(() => process.exit(0), 5000).unref?.();
    maybeExit();
  });
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  void main();
}

export { probeLock, handleLine, PROBE_BODY };
