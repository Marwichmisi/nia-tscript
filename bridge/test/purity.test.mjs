// S3 — pureté stdout : stdout = MCP pur, logs sur stderr préfixés (ticket #11).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bridgeDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceFiles() {
  return fs
    .readdirSync(bridgeDir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(bridgeDir, f), "utf8") }));
}

describe("S3 — stdout pure, stderr préfixé", () => {
  it("aucun console.log dans bridge/*.mjs (ni console.info/debug)", () => {
    const offenders = [];
    for (const { file, text } of sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (/(^|[^a-zA-Z])console\.(log|info|debug)\b/.test(line)) {
          offenders.push(`${file}:${i + 1}:${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, []);
  });

  it("lib.mjs n'écrit jamais (pas de stdout/stderr/console.error)", () => {
    const lib = fs.readFileSync(path.join(bridgeDir, "lib.mjs"), "utf8");
    assert.ok(!lib.includes("process.stdout"), "lib ne touche pas stdout");
    assert.ok(!lib.includes("process.stderr"), "lib ne touche pas stderr");
    assert.ok(!lib.includes("console.error"), "lib ne loggue pas (runtime seul)");
  });

  it("bridge.mjs ne loggue que via console.error préfixé [bridge]", () => {
    const runtime = fs.readFileSync(path.join(bridgeDir, "bridge.mjs"), "utf8");
    assert.ok(runtime.includes("[bridge]"), "logs préfixés [bridge]");
    assert.ok(runtime.includes("process.stdout.write"), "réponses via stdout.write");
  });
});
