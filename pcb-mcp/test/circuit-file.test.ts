// Ticket #38 — `circuit.json` versionné, recréé si absent, corrompu = erreur visible.
// Seam : `pcb-mcp/src/project.ts` (fichier disque, observable).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CIRCUIT_SCHEMA_VERSION,
  ensureCircuitFile,
  ensureProjectLayout,
  parseCircuitFile,
  projectCircuitPath,
  readCircuitFile,
  serializeCircuitFile,
} from "../src/project";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nia-circuit-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("circuit.json versionné", () => {
  test("version de schéma exposée (= 1)", () => {
    expect(CIRCUIT_SCHEMA_VERSION).toBe(1);
  });

  test("serialise enveloppe versionnée atomique sans .tmp", () => {
    const dir = path.join(tmpRoot, "a");
    fs.mkdirSync(dir, { recursive: true });
    const text = serializeCircuitFile([{ type: "source" }]);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["version"]).toBe(CIRCUIT_SCHEMA_VERSION);
    expect(parsed["circuitJson"]).toEqual([{ type: "source" }]);
  });

  test("absent → recréé vide versionné", () => {
    const dir = path.join(tmpRoot, "b");
    fs.mkdirSync(dir, { recursive: true });
    expect(ensureCircuitFile(dir)).toBe("created");
    expect(readCircuitFile(dir)).toEqual([]);
    const raw = JSON.parse(fs.readFileSync(projectCircuitPath(dir), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(CIRCUIT_SCHEMA_VERSION);
  });

  test("existant valide → exists, éléments relus", () => {
    const dir = path.join(tmpRoot, "c");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(projectCircuitPath(dir), serializeCircuitFile([{ type: "x" }]));
    expect(ensureCircuitFile(dir)).toBe("exists");
    expect(readCircuitFile(dir)).toEqual([{ type: "x" }]);
  });

  test("legacy tableau nu → migré (données préservées, réécrit versionné)", () => {
    const dir = path.join(tmpRoot, "d");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(projectCircuitPath(dir), JSON.stringify([{ type: "legacy" }]));
    expect(ensureCircuitFile(dir)).toBe("migrated");
    expect(readCircuitFile(dir)).toEqual([{ type: "legacy" }]);
    const raw = JSON.parse(fs.readFileSync(projectCircuitPath(dir), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(CIRCUIT_SCHEMA_VERSION);
  });

  test("corrompu → erreur d'ouverture visible (jamais accepté silencieusement)", () => {
    const dir = path.join(tmpRoot, "e");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(projectCircuitPath(dir), "{ pas du json");
    expect(() => ensureCircuitFile(dir)).toThrow(/circuit\.json.*corrompu|illisible/i);
    expect(() => readCircuitFile(dir)).toThrow(/circuit\.json/i);
    // Le fichier corrompu n'est NI écrasé NI vidé silencieusement.
    expect(fs.readFileSync(projectCircuitPath(dir), "utf8")).toBe("{ pas du json");
  });

  test("version future / enveloppe invalide → erreur visible", () => {
    const dir = path.join(tmpRoot, "f");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      projectCircuitPath(dir),
      JSON.stringify({ version: CIRCUIT_SCHEMA_VERSION + 99, circuitJson: [] }),
    );
    expect(() => readCircuitFile(dir)).toThrow(/version/i);
    fs.writeFileSync(projectCircuitPath(dir), JSON.stringify({ version: 1 }));
    expect(() => readCircuitFile(dir)).toThrow(/circuit\.json/i);
    expect(() => parseCircuitFile("")).toThrow(/circuit\.json/i);
  });

  test("ensureProjectLayout crée un circuit versionné (plus de tableau nu)", () => {
    const dir = path.join(tmpRoot, "g");
    expect(ensureProjectLayout(dir, "vide")).toBe("created");
    const raw = JSON.parse(fs.readFileSync(projectCircuitPath(dir), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(CIRCUIT_SCHEMA_VERSION);
    expect(raw["circuitJson"]).toEqual([]);
  });
});
