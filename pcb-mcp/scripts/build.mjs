// Build sidecar : `bun build --compile` → src-tauri/binaries/pcb-mcp-<triple>.
// Ticket #40 : vérification taille + permissions après compilation
// (refus du stub et du world-writable, spec #37 → Build).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySidecar } from "./verify-sidecar.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(root);
const triple = (process.env.TARGET_TRIPLE ?? execSync("rustc --print host-tuple").toString().trim());
if (!triple) throw new Error("triple vide (rustc --print host-tuple)");
const ext = process.platform === "win32" ? ".exe" : "";
const out = path.join(repoRoot, "src-tauri", "binaries", `pcb-mcp-${triple}${ext}`);
const entry = path.join(root, "src", "server.ts");

console.error(`[build] bun build --compile ${entry} → ${out}`);
execSync(`bun build ${entry} --outfile ${out} --compile --target=bun`, { stdio: "inherit", cwd: root });
fs.chmodSync(out, 0o755);
console.error(`[build] ok : ${out} (${fs.statSync(out).size} octets)`);
const checked = verifySidecar(out);
console.error(`[build] sidecar vérifié : ${checked.path} (${checked.size} octets, non world-writable)`);
