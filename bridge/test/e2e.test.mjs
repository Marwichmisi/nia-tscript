// S1+S2+S4 — E2E frontière : bridge stdio ↔ stub HTTP fidèle (ticket #11).
// Le stub imite pcb-mcp : bearer, headers MCP-*, JSON + SSE, 401/400.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeBin = path.join(here, "..", "bridge.mjs");
const TOKEN = "e2e-token-" + Math.random().toString(36).slice(2);
const VER = "2026-07-28";

let server;
let port = 0;
let lastHeaders = null;
let requests = 0;

function stubHandler(req, res) {
  requests++;
  lastHeaders = { ...req.headers };
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let msg = {};
    try {
      msg = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end("bad json");
      return;
    }
    // initialize legacy : accepté sans headers modernes (pcb-mcp `legacy: 'stateless'`).
    // Comme le vrai serveur : version moderne en header SANS enveloppe `_meta` ⇒ -32020.
    if (msg.method === "initialize") {
      const hv = req.headers["mcp-protocol-version"] ?? "";
      if (/^2026-/.test(hv) && !msg?.params?._meta) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32020, message: "HeaderMismatch" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: { protocolVersion: VER, serverInfo: { name: "stub", version: "0.0.0" } } }));
      return;
    }
    // Sans _meta ni headers MCP : legacy stateless (vrai client SDK stdio).
    const hasMcpHeaders = "mcp-protocol-version" in req.headers || "mcp-method" in req.headers;
    if (msg?.params?._meta || hasMcpHeaders) {
      if (req.headers["mcp-protocol-version"] !== VER) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32020, message: "HeaderMismatch" } }));
        return;
      }
    }
    // Route SSE dédiée pour vérifier l'extraction `data:`.
    if (msg?.params?.name === "sse_tool") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sse: true } });
      res.end(`: ping\n\ndata: ${payload}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: { echo: msg.method, state: "shared-stub" } }));
  });
}

const liveChildren = new Set();

function startBridge(lockPath) {
  const child = spawn("node", [bridgeBin], {
    env: { ...process.env, NIATSCIRCUIT_MCP_LOCK: lockPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);
  child.on("exit", () => liveChildren.delete(child));
  child.stderr.on("data", () => {});
  return child;
}

async function stopBridge(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise((r) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      r();
    }, 2000);
    child.on("exit", () => {
      clearTimeout(t);
      r();
    });
  });
  liveChildren.delete(child);
}

function stopAll() {
  return Promise.all([...liveChildren].map((c) => stopBridge(c)));
}

function rpc(child, obj) {
  return new Promise((resolve) => {
    const want = obj.id;
    let acc = "";
    const onData = (chunk) => {
      acc += chunk.toString();
      const lines = acc.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === want) {
            child.stdout.off("data", onData);
            resolve(parsed);
          }
        } catch {}
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  });
}

function writeLock(dir) {
  const fp = path.join(dir, "mcp.json");
  fs.writeFileSync(fp, JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, token: TOKEN, protocolVersion: VER }));
  return fp;
}

before(async () => {
  server = createServer(stubHandler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  await stopAll();
  await new Promise((resolve) => {
    try {
      server.closeAllConnections?.();
    } catch {}
    server.close(resolve);
  });
});

describe("S1 — forward stdio→HTTP", () => {
  it("tools/list relayé avec headers MCP-* et id corrélé", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const child = startBridge(writeLock(dir));
    await new Promise((r) => setTimeout(r, 600)); // probe initiale
    const body = {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": VER, "io.modelcontextprotocol/clientCapabilities": {} } },
    };
    const res = await rpc(child, body);
    assert.equal(res.id, 11);
    assert.equal(res.result.echo, "tools/list");
    assert.equal(res.result.state, "shared-stub");
    assert.equal(lastHeaders["mcp-method"], "tools/list");
    assert.equal(lastHeaders["mcp-protocol-version"], VER);
    assert.equal(lastHeaders.authorization, `Bearer ${TOKEN}`);
    await stopBridge(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("SSE : data: extrait en une ligne JSON pure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const child = startBridge(writeLock(dir));
    await new Promise((r) => setTimeout(r, 600));
    const res = await rpc(child, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "sse_tool" } });
    assert.equal(res.id, 12);
    assert.equal(res.result.sse, true);
    await stopBridge(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stdin fermée aussitôt : la réponse en vol est drainée avant exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const fp = writeLock(dir);
    const child = startBridge(fp);
    await new Promise((r) => setTimeout(r, 700)); // probe initiale
    const done = new Promise((resolve) => child.on("exit", resolve));
    let raw = "";
    child.stdout.on("data", (c) => (raw += c.toString()));
    child.stdin.write('{"jsonrpc":"2.0","id":13,"method":"tools/list","params":{}}\n');
    child.stdin.end(); // fermeture immédiate : ne doit pas perdre la requête
    await done;
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.id, 13);
    assert.ok(parsed.result, "réponse drainée malgré stdin fermée");
    liveChildren.delete(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("notification : aucune ligne sur stdout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const child = startBridge(writeLock(dir));
    await new Promise((r) => setTimeout(r, 600));
    let bytes = 0;
    child.stdout.on("data", (c) => (bytes += c.length));
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}\n');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(bytes, 0);
    await stopBridge(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("S2 — app fermée, jamais de headless", () => {
  it("lockfile absent ⇒ -32000 « ouvre l'app », pas de spawn", async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-")), "nope", "mcp.json");
    const child = startBridge(missing);
    await new Promise((r) => setTimeout(r, 400));
    const res = await rpc(child, { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} });
    assert.equal(res.error.code, -32000);
    assert.match(res.error.message, /ouvre l'app/);
    await stopBridge(child);
  });

  it("reprise après ouverture de l'app : re-probe puis forward", async () => {
    // Port d'abord vide (app fermée) puis occupé (app ouverte).
    const probe = createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const p2 = probe.address().port;
    await new Promise((r) => probe.close(r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const fp = path.join(dir, "mcp.json");
    fs.writeFileSync(fp, JSON.stringify({ url: `http://127.0.0.1:${p2}/mcp`, token: TOKEN, protocolVersion: VER }));
    const child = startBridge(fp);
    await new Promise((r) => setTimeout(r, 500)); // probe initiale KO → dégradé
    const down = await rpc(child, { jsonrpc: "2.0", id: 23, method: "tools/list", params: {} });
    assert.equal(down.error.code, -32000);
    // L'app ouvre : même URL, même token.
    const late = createServer(stubHandler);
    await new Promise((r) => late.listen(p2, "127.0.0.1", r));
    const up = await rpc(child, { jsonrpc: "2.0", id: 24, method: "tools/list", params: {} });
    assert.equal(up.id, 24);
    assert.equal(up.result.state, "shared-stub");
    await stopBridge(child);
    await new Promise((r) => { try { late.closeAllConnections?.(); } catch {} late.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("port fermé (probe KO) ⇒ -32000 avec id préservé", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const fp = path.join(dir, "mcp.json");
    fs.writeFileSync(fp, JSON.stringify({ url: "http://127.0.0.1:1/mcp", token: "tok", protocolVersion: VER }));
    const child = startBridge(fp);
    await new Promise((r) => setTimeout(r, 3500)); // probe 2,5 s + marge
    const res = await rpc(child, { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} });
    assert.equal(res.id, 22);
    assert.equal(res.error.code, -32000);
    await stopBridge(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("S4 — deux bridges simultanés, même état", () => {
  it("opencode + claude simulés : ids corrélés, un seul serveur", async () => {
    const before = requests;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const fp = writeLock(dir);
    const a = startBridge(fp);
    const b = startBridge(fp);
    await new Promise((r) => setTimeout(r, 700));
    const [ra, rb] = await Promise.all([
      rpc(a, { jsonrpc: "2.0", id: "A-1", method: "tools/list", params: {} }),
      rpc(b, { jsonrpc: "2.0", id: "B-1", method: "tools/list", params: {} }),
    ]);
    assert.equal(ra.id, "A-1");
    assert.equal(rb.id, "B-1");
    assert.equal(ra.result.state, rb.result.state);
    assert.ok(requests - before >= 4, `probe×2 + requêtes×2 attendues (got ${requests - before})`);
    await Promise.all([stopBridge(a), stopBridge(b)]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("framing intact en rafale : chaque ligne stdout parse en JSON-RPC", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-e2e-"));
    const fp = writeLock(dir);
    const child = startBridge(fp);
    await new Promise((r) => setTimeout(r, 700));
    let raw = "";
    child.stdout.on("data", (c) => (raw += c.toString()));
    const burst = Array.from({ length: 10 }, (_, i) => ({
      jsonrpc: "2.0",
      id: `F-${i}`,
      method: "tools/call",
      params: { name: "pcb_state", arguments: {} },
    }));
    for (const m of burst) child.stdin.write(`${JSON.stringify(m)}\n`);
    await new Promise((r) => setTimeout(r, 1500));
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 10);
    const ids = new Set();
    for (const line of lines) {
      const parsed = JSON.parse(line); // throw si framing cassé (ex console.log)
      assert.equal(parsed.jsonrpc, "2.0");
      assert.ok(typeof parsed.id === "string" && parsed.id.startsWith("F-"));
      ids.add(parsed.id);
    }
    assert.equal(ids.size, 10, "ids tous corrélés, aucune perte/duplicat");
    await stopBridge(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
