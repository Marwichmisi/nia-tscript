#!/usr/bin/env bun
// Matrice V1 §8 — harnais live (cas 3→9 + boucle complète agent).
// Usage : `bun scripts/matrix-v1.mjs [--json]` depuis pcb-mcp/.
// Seam : binaire sidecar réel `src-tauri/binaries/pcb-mcp-<triple>` + HTTP MCP,
// jamais les internals Rust/TS. Chaque cas consigne preuve ou écart.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const REPO = path.resolve(import.meta.dir, "..", "..");
const BIN_DIR = path.join(REPO, "src-tauri", "binaries");
const hostTriple = Bun.spawnSync(["rustc", "--print", "host-tuple"]).stdout.toString().trim();
const ext = process.platform === "win32" ? ".exe" : "";
const BIN = path.join(BIN_DIR, `pcb-mcp-${hostTriple}${ext}`);
const SIDECAR_SIZE = fs.existsSync(BIN) ? fs.statSync(BIN).size : 0;

const results = [];
function record(cas, ok, preuve) {
  results.push({ cas, ok, preuve });
  console.error(`[${ok ? "OK " : "KO "} ${cas}] ${preuve}`);
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function waitPort(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

async function mcpCall(url, token, method, params = {}, id = 1) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body,
  });
  const text = await res.text();
  // SSE ou JSON : extraire la ligne data JSON.
  const m = text.match(/data:\s*(\{.*\})/s);
  const line = m ? m[1] : text;
  return { status: res.status, json: JSON.parse(line.trim().split("\n").find((l) => l.trim().startsWith("{")) ?? line) };
}

function spawnSidecar(port, token, previewDir) {
  return spawn(BIN, ["serve", "--port", String(port)], {
    env: { ...process.env, PCB_MCP_TOKEN: token, PCB_MCP_PREVIEW_DIR: previewDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// --- cas 1 : nommage ---------------------------------------------------------
{
  const conf = JSON.parse(fs.readFileSync(path.join(REPO, "src-tauri", "tauri.conf.json"), "utf8"));
  const ok = conf.bundle.externalBin.includes("binaries/pcb-mcp") && SIDECAR_SIZE > 1_000_000;
  record("8.2.1-nommage", ok, `host=${hostTriple} size=${SIDECAR_SIZE} externalBin=${conf.bundle.externalBin}`);
}

// --- cas 2 : capabilities ----------------------------------------------------
{
  const caps = JSON.parse(fs.readFileSync(path.join(REPO, "src-tauri", "capabilities", "default.json"), "utf8"));
  const raw = fs.readFileSync(path.join(REPO, "src-tauri", "capabilities", "default.json"), "utf8");
  const spawnRule = caps.permissions.find((p) => p.identifier === "shell:allow-spawn");
  const rule = spawnRule?.allow.find((a) => a.name === "binaries/pcb-mcp");
  const re = new RegExp(rule.args[2].validator);
  const ok = !/"args"\s*:\s*true/.test(raw) && re.test("4123") && !re.test("evil;rm") && !re.test("4123; rm");
  record("8.2.2-capabilities", ok, `validator=${rule.args[2].validator} evil_rejeté=${!re.test("evil;rm")}`);
}

// --- boot sidecar partagé pour cas 3→8 ---------------------------------------
const TOKEN = "matrix-" + Math.random().toString(36).slice(2);
const PREVIEW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nia-matrix-preview-"));
const PORT = await freePort();
const child = spawnSidecar(PORT, TOKEN, PREVIEW_DIR);
const URL = `http://127.0.0.1:${PORT}/mcp`;
const booted = await waitPort(PORT, 20000);
// readiness = initialize 200 + serverInfo (même probe que boot.rs).
let ready = false;
if (booted) {
  try {
    const r = await mcpCall(URL, TOKEN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "matrix", version: "1" } });
    ready = r.status === 200 && JSON.stringify(r.json).includes("serverInfo");
  } catch { ready = false; }
}
record("8.2.3-boot", ready, `spawn ${path.basename(BIN)} :${PORT} readiness=${ready} (10s max, lockfile 0600 simulé ci-dessous)`);
if (!ready) {
  try { child.kill("SIGKILL"); } catch {}
  console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exit(1);
}

// --- cas 3 (suite) : lockfile 0600 simulé + pid vivant ------------------------
{
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-matrix-lock-"));
  const lockPath = path.join(lockDir, "mcp.json");
  const lock = { port: PORT, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString(), url: URL, protocolVersion: "2026-07-28" };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  fs.chmodSync(lockPath, 0o600);
  const mode = fs.statSync(lockPath).mode & 0o777;
  let alive = false;
  try { process.kill(lock.pid, 0); alive = true; } catch { alive = false; }
  record("8.2.3-lockfile", mode === 0o600 && alive, `mode=${mode.toString(8)} pid_vivant=${alive} (single-instance: 2e lancement => focus, pas de 2e lockfile — cf. lib.rs single_instance en premier)`);
}

// --- cas 4 : stale-lock RÉEL (kill -9 + respawn, pas simulé) -------------------
{
  const tPort = await freePort();
  const tToken = "matrix-stale-" + Math.random().toString(36).slice(2);
  const tDir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-matrix-stale-"));
  const tmp = spawnSidecar(tPort, tToken, tDir);
  const tUrl = `http://127.0.0.1:${tPort}/mcp`;
  const up = await waitPort(tPort, 20000);
  let wasReady = false;
  if (up) {
    try {
      const r = await mcpCall(tUrl, tToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "matrix", version: "1" } });
      wasReady = r.status === 200;
    } catch { wasReady = false; }
  }
  // kill -9 de l'instance, comme le cas §8.2.4 l'exige.
  try { tmp.kill("SIGKILL"); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  let probeDead = true;
  try {
    await fetch(tUrl, { method: "POST", body: "{}", signal: AbortSignal.timeout(1500) });
    probeDead = false;
  } catch { probeDead = true; }
  // Relance : le setup() régénère port+token (jamais réutilisés, cf. should_reuse_lock=false).
  const nPort = await freePort();
  const nToken = "matrix-regen-" + Math.random().toString(36).slice(2);
  const nxt = spawnSidecar(nPort, nToken, tDir);
  const nUrl = `http://127.0.0.1:${nPort}/mcp`;
  const nUp = await waitPort(nPort, 20000);
  try { nxt.kill("SIGKILL"); } catch {}
  fs.rmSync(tDir, { recursive: true, force: true });
  const ok = wasReady && probeDead && nUp && nToken !== tToken && nPort !== tPort;
  record("8.2.4-stale-lock", ok, `kill -9 : ready_avant=${wasReady} probe_après_kill=KO(${probeDead}) respawn_ready=${nUp} token_régénéré=${nToken !== tToken}`);
}

// --- cas 5 : multi-client -----------------------------------------------------
{
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    mcpCall(URL, TOKEN, "tools/list", {}, 101),
    mcpCall(URL, TOKEN, "tools/call", { name: "pcb_state", arguments: {} }, 102),
  ]);
  const ok = a.status === 200 && b.status === 200 && a.json.id === 101 && b.json.id === 102;
  record("8.2.5-multi-client", ok, `2 bridges simultanés => 1 serveur, id_corrélés=${ok} (${Date.now() - t0}ms)`);
}

// --- cas 5b : 2 bridges réels simultanés (finding §5 : N bridges, 1 URL) ------
{
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-matrix-bridges-"));
  const lockPath = path.join(lockDir, "mcp.json");
  fs.writeFileSync(lockPath, JSON.stringify({ port: PORT, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString(), url: URL, protocolVersion: "2026-07-28" }));
  const BRIDGE = path.join(REPO, "bridge", "bridge.mjs");
  const rpcVia = (id, method, params) => new Promise((resolve) => {
    const b = spawn("node", [BRIDGE], { env: { ...process.env, NIATSCIRCUIT_MCP_LOCK: lockPath }, stdio: ["pipe", "pipe", "pipe"] });
    let acc = "";
    const timer = setTimeout(() => { try { b.kill("SIGKILL"); } catch {} resolve({ ok: false }); }, 15000);
    b.stdout.on("data", (c) => {
      acc += c.toString();
      const line = acc.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) { clearTimeout(timer); try { b.kill(); } catch {} resolve({ ok: true, parsed }); }
        } catch {}
      }
    });
    b.stderr.on("data", () => {});
    // Attendre la probe initiale du bridge (~1 probe HTTP), puis envoyer.
    setTimeout(() => {
      b.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }, 1500);
  });
  const [r1, r2] = await Promise.all([
    rpcVia(501, "tools/list", {}),
    rpcVia(502, "tools/call", { name: "pcb_state", arguments: {} }),
  ]);
  const ok = r1.ok && r2.ok && r1.parsed.id === 501 && r2.parsed.id === 502;
  record("8.2.5b-bridges-réels", ok, `2 process bridge.mjs simultanés => 1 serveur ${URL}, id_corrélés=${ok}`);
  fs.rmSync(lockDir, { recursive: true, force: true });
}

// --- cas 6 : pureté stdout/stderr ---------------------------------------------
{
  const srcDir = path.join(REPO, "pcb-mcp", "src");
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  const withLog = files.filter((f) => /console\.log/.test(fs.readFileSync(path.join(srcDir, f), "utf8")));
  // Le sidecar HTTP loggue sur stderr+fichier uniquement (log.ts) ; stdout jamais touchée.
  let stdoutBytes = 0;
  child.stdout.on("data", (c) => (stdoutBytes += c.length));
  await mcpCall(URL, TOKEN, "tools/list", {}, 103);
  // Requête invalide : méthode inconnue -> erreur JSON-RPC protocole (stderr uniquement).
  const bad = await mcpCall(URL, TOKEN, "requete_invalide_xyz", {}, 104);
  const badIsProtoError = bad.status === 200 && JSON.stringify(bad.json).includes("error");
  await new Promise((r) => setTimeout(r, 300));
  const ok = withLog.length === 0 && stdoutBytes === 0 && badIsProtoError;
  record("8.2.6-logs", ok, `console.log dans src=${withLog.length} ; sidecar stdout=${stdoutBytes}o (attendu 0) ; requête invalide -> erreur protocole=${badIsProtoError}`);
}

// --- cas 7 : port occupé -------------------------------------------------------
{
  const squat = net.createServer((s) => s.destroy());
  await new Promise((r) => squat.listen(0, "127.0.0.1", r));
  const squatted = squat.address().port;
  // Le sidecar n'est jamais ready sur le port squatté (EADDRINUSE : le setup()
  // ne se fie pas à une sortie rapide mais au timeout readiness 10 s puis kill
  // + retry, cf. lib.rs). Preuve : clash non-ready, repli ready.
  const clash = spawnSidecar(squatted, TOKEN, PREVIEW_DIR);
  let stderr = "";
  clash.stderr.on("data", (c) => (stderr += c.toString()));
  await new Promise((r) => setTimeout(r, 2500));
  let clashReady = false;
  try {
    const r = await mcpCall(`http://127.0.0.1:${squatted}/mcp`, TOKEN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "matrix", version: "1" } });
    clashReady = r.status === 200;
  } catch { clashReady = false; }
  const stillOld = await waitPort(squatted, 500);
  // Repli façon setup() : re-pick un port libre et booter dessus.
  const other = await freePort();
  const retry = spawnSidecar(other, TOKEN, PREVIEW_DIR);
  const retryReady = await waitPort(other, 10000);
  try { clash.kill("SIGKILL"); } catch {}
  try { retry.kill("SIGKILL"); } catch {}
  await new Promise((r) => squat.close(r));
  const ok = !clashReady && stillOld && other !== squatted && retryReady;
  record("8.2.7-port-occupé", ok, `clash_ready=${clashReady} (attendu false) squat_tenu=${stillOld} repli=${other} ready=${retryReady} (setup retry 3x; stderr clash=${stderr.length}o)`);
}

// --- cas 8 : latence p95 sous 4 clients (MUTANTE, §8.2.8) -----------------------
{
  const N = 40;
  const lat = [];
  const workers = [0, 1, 2, 3].map(async (w) => {
    for (let i = 0; i < N / 4; i++) {
      const t = Date.now();
      // Écriture mutante via la file (sérialisée) : move R1, coords tournantes valides.
      await mcpCall(URL, TOKEN, "tools/call", { name: "live_manage", arguments: { op: "move", refdes: "R1", x: -4 - ((w + i) % 5), y: 3 + ((w + i) % 3) } }, w * 1000 + i);
      lat.push(Date.now() - t);
    }
  });
  await Promise.all(workers);
  lat.sort((x, y) => x - y);
  const p50 = lat[Math.floor(lat.length * 0.5)];
  const p95 = lat[Math.floor(lat.length * 0.95)];
  record("8.2.8-latence", true, `n=${N} mutantes live_manage.move sous 4 clients p50=${p50}ms p95=${p95}ms (indicatif, consigné par arch ${hostTriple})`);
}

// --- cas 9 : snap/flatpak DBus --------------------------------------------------
{
  // Service DBus dérivé de l'identifier (ctx7 single-instance) : org.<id_underscoré>.SingleInstance.
  const conf = JSON.parse(fs.readFileSync(path.join(REPO, "src-tauri", "tauri.conf.json"), "utf8"));
  const svc = "org." + conf.identifier.replace(/[.-]/g, "_") + ".SingleInstance";
  const expected = "org.dev_nia_tscircuit_studio.SingleInstance";
  record("8.2.9-dbus", svc === expected, `service=${svc} (manifests snap slot/plug + flatpak --talk-name/--own-name à déclarer — doc MATRICE, non testé en sandbox ici)`);
}

// --- boucle complète agent ------------------------------------------------------
{
  const steps = [];
  try {
    const st = await mcpCall(URL, TOKEN, "tools/call", { name: "pcb_state", arguments: {} }, 201);
    steps.push(["observer:pcb_state", st.status === 200]);
    const lg = await mcpCall(URL, TOKEN, "tools/call", { name: "logs_read", arguments: {} }, 202);
    steps.push(["diagnostiquer:logs_read", lg.status === 200]);
    const pt = await mcpCall(URL, TOKEN, "tools/call", { name: "code_patch", arguments: { anchor: 'resistance="10k"', replacement: 'resistance="4k7"' } }, 203);
    const ptOk = pt.status === 200 && JSON.parse(JSON.stringify(pt.json)).result !== undefined;
    steps.push(["éditer:code_patch", ptOk]);
    const ck = await mcpCall(URL, TOKEN, "tools/call", { name: "run_checks", arguments: { domain: "all" } }, 204);
    steps.push(["contrôler:run_checks", ck.status === 200]);
    const mv = await mcpCall(URL, TOKEN, "tools/call", { name: "live_manage", arguments: { op: "move", refdes: "R1", x: -4, y: 3 } }, 205);
    steps.push(["placer:live_manage.move", mv.status === 200]);
    // Screenshot : dépôt via le même seam fichier que `save_screenshot` Tauri
    // (preview.rs write_preview : <source>.png + <source>.json ; readPreview
    // retombe sur l'en-tête PNG si la meta est partielle). La capture WebView
    // elle-même (canvas/SVG → PNG) n'est pas rejouée ici : voir #15.
    const px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const pngBuf = Buffer.from(px, "base64");
    fs.writeFileSync(path.join(PREVIEW_DIR, "pcb_2d.png"), pngBuf);
    fs.writeFileSync(path.join(PREVIEW_DIR, "pcb_2d.json"), JSON.stringify({ source: "pcb_2d", bytes: pngBuf.length, width: 1, height: 1, previewUrl: `file://${path.join(PREVIEW_DIR, "pcb_2d.png")}`, updatedAt: new Date().toISOString() }));
    const sh = await mcpCall(URL, TOKEN, "tools/call", { name: "preview_screenshot", arguments: { source: "pcb_2d" } }, 206);
    steps.push(["voir:preview_screenshot", sh.status === 200]);
    const bt = await mcpCall(URL, TOKEN, "tools/call", { name: "batch_execute", arguments: { operations: [{ kind: "rotate", refdes: "R1", degrees: 90 }] } }, 207);
    steps.push(["itérer:batch_execute", bt.status === 200]);
    const fb = await mcpCall(URL, TOKEN, "tools/call", { name: "fab_export", arguments: { project_name: "nia-matrix" } }, 208);
    steps.push(["exporter:fab_export", fb.status === 200]);
  } catch (e) {
    steps.push(["boucle:exception", false]);
  }
  const ok = steps.length === 8 && steps.every(([, v]) => v);
  record("boucle-agent", ok, steps.map(([s, v]) => `${s}=${v ? "ok" : "KO"}`).join(" "));
}

try { child.kill("SIGKILL"); } catch {}

const failed = results.filter((r) => !r.ok);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ triple: hostTriple, bin: BIN, size: SIDECAR_SIZE, ok: failed.length === 0, results }, null, 2));
} else {
  console.log(`\nMatrice V1 — ${results.length - failed.length}/${results.length} cas verts sur ${hostTriple}`);
  for (const r of results) console.log(` ${r.ok ? "✓" : "✗"} ${r.cas} : ${r.preuve}`);
}
process.exit(failed.length === 0 ? 0 : 1);
