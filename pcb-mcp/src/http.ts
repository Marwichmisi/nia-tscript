// Serveur HTTP stateless 2026-07-28 sur 127.0.0.1.
// Guards (ordre) : méthode POST seule → Host localhost → Origin localhost →
// Bearer éphémère → handler SDK (versions/headers mismatch gérés par le SDK :
// 400 + -32020/-32022, méthode inconnue 404 + -32601).
// Logs sur stderr uniquement (voir log.ts), jamais sur stdout.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { buildHandler, loadOpenProjectCode } from "./mcp.js";
import { logLine } from "./log.js";

export interface StartOptions {
  port: number;
  token: string;
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer error="invalid_token", error_description="bearer manquant ou invalide"',
    connection: "close",
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+?)\s*$/);
  const tok = m?.[1]?.trim();
  return tok ? tok : null;
}

export async function startServer({ port, token }: StartOptions): Promise<Server> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`port invalide : ${port}`);
  }
  if (!token) throw new Error("token bearer requis (PCB_MCP_TOKEN ou --token)");

  const handler = buildHandler();
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "not-found" }));
      return;
    }
    if (req.method !== "POST") {
      // Spec : GET/DELETE sur endpoint moderne-only ⇒ 405.
      res.writeHead(405, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "method-not-allowed" }));
      return;
    }
    // DNS rebinding : Host non-localhost ⇒ 403 (le guard répond lui-même).
    if (!validateHost(req, res)) return;
    // Origin présente et non-localhost ⇒ 403. Absente ⇒ passe (clients MCP).
    if (!validateOrigin(req, res)) return;
    const bearer = extractBearer(req);
    if (bearer !== token) {
      unauthorized(res);
      return;
    }
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  logLine("info", `écoute sur http://127.0.0.1:${port}/mcp (stateless 2026-07-28 + legacy initialize)`);
  // Disque source de vérité (ticket #43) : au boot, la mémoire est un cache
  // vide — rechargée depuis le main.tsx du Projet ouvert s'il y en a un.
  if (loadOpenProjectCode()) {
    logLine("info", "boot : TSX rechargé depuis le disque (projet ouvert)");
  }
  return server;
}
