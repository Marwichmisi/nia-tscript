// Matrice V1 §8 — tranche statique (cas 1+2) : nommage triple + capabilities négatives.
// Seam : fichiers versionnés (tauri.conf.json + default.json + binaire host).
// Source de vérité indépendante : findings §2/§4 (pas le code sous test).
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
const TAURI_CONF = path.join(REPO, "src-tauri", "tauri.conf.json");
const CAPS = path.join(REPO, "src-tauri", "capabilities", "default.json");
const BIN_DIR = path.join(REPO, "src-tauri", "binaries");

// §8.1 : les 6 triples desktop supportés (rustc --print target-list, findings §1).
export const EXPECTED_TRIPLES = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
];

describe("Matrice V1 §8.2.1 — nommage triple + externalBin", () => {
  test("tauri.conf déclare binaries/pcb-mcp en externalBin (nom nu)", () => {
    const conf = JSON.parse(fs.readFileSync(TAURI_CONF, "utf8"));
    expect(conf.bundle.externalBin).toContain("binaries/pcb-mcp");
  });

  test("binaire hôte présent, non-vide, +x (preuve build --compile)", () => {
    const host = Bun.spawnSync(["rustc", "--print", "host-tuple"]);
    const triple = new TextDecoder().decode(host.stdout).trim();
    expect(EXPECTED_TRIPLES).toContain(triple);
    const bin = path.join(BIN_DIR, `pcb-mcp-${triple}`);
    const st = fs.statSync(bin);
    expect(st.size).toBeGreaterThan(1_000_000);
    expect(st.mode & 0o111).toBeGreaterThan(0);
  });

  test("convention suffixe exacte par triple (6 fichiers attendus au build CI)", () => {
    const expected: Record<string, string> = {
      "x86_64-unknown-linux-gnu": "pcb-mcp-x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu": "pcb-mcp-aarch64-unknown-linux-gnu",
      "x86_64-pc-windows-msvc": "pcb-mcp-x86_64-pc-windows-msvc.exe",
      "aarch64-pc-windows-msvc": "pcb-mcp-aarch64-pc-windows-msvc.exe",
      "x86_64-apple-darwin": "pcb-mcp-x86_64-apple-darwin",
      "aarch64-apple-darwin": "pcb-mcp-aarch64-apple-darwin",
    };
    expect(EXPECTED_TRIPLES).toEqual(Object.keys(expected));
    for (const [triple, file] of Object.entries(expected)) {
      // Convention doc sidecar : binaire embarqué = nom nu + "-" + triple (+ .exe).
      const ext = triple.includes("windows") ? ".exe" : "";
      expect(file).toBe(`pcb-mcp-${triple}${ext}`);
      expect(path.join(BIN_DIR, file).startsWith(BIN_DIR)).toBe(true);
    }
  });
});

describe("Matrice V1 §8.2.2 — capabilities négatives (jamais args:true)", () => {
  test("aucun 'args: true' dans les capabilities commitées", () => {
    const raw = fs.readFileSync(CAPS, "utf8");
    expect(raw).not.toMatch(/"args"\s*:\s*true/);
  });

  test("spawn verrouillé : serve --port + validator digits, ordre exact", () => {
    const caps = JSON.parse(fs.readFileSync(CAPS, "utf8"));
    const spawn = caps.permissions.find(
      (p: { identifier?: string }) => p.identifier === "shell:allow-spawn",
    );
    expect(spawn).toBeDefined();
    const rule = spawn.allow.find(
      (a: { name?: string }) => a.name === "binaries/pcb-mcp",
    );
    expect(rule.sidecar).toBe(true);
    expect(rule.args[0]).toBe("serve");
    expect(rule.args[1]).toBe("--port");
    expect(rule.args[2].validator).toBe("^[0-9]{2,5}$");
  });

  test("stdin_write + kill présents, allow-execute absent sur pcb-mcp", () => {
    const caps = JSON.parse(fs.readFileSync(CAPS, "utf8"));
    const ids = caps.permissions.map((p: { identifier?: string }) => p.identifier);
    expect(ids).toContain("shell:allow-stdin-write");
    expect(ids).toContain("shell:allow-kill");
    const exec = caps.permissions.find(
      (p: { identifier?: string }) => p.identifier === "shell:allow-execute",
    );
    const touchesMcp = JSON.stringify(exec ?? {}).includes("pcb-mcp");
    expect(touchesMcp).toBe(false);
  });

  test("evil;rm rejeté par le validator (preuve négative indépendante)", () => {
    const caps = JSON.parse(fs.readFileSync(CAPS, "utf8"));
    const spawn = caps.permissions.find(
      (p: { identifier?: string }) => p.identifier === "shell:allow-spawn",
    );
    const rule = spawn.allow.find(
      (a: { name?: string }) => a.name === "binaries/pcb-mcp",
    );
    const re = new RegExp(rule.args[2].validator);
    expect(re.test("4123")).toBe(true);
    expect(re.test("evil;rm")).toBe(false);
    expect(re.test("4123; rm -rf /")).toBe(false);
  });
});
