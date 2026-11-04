// Bascule noire (#blackscreen, v0.1.4) — npm hisse un zod 4 unique que les
// paquets tscircuit (peer `3`/`^3`/`*` fantômes : eval, circuit-json-util,
// props, modelprinter + copies imbriquées de schematic-viewer) résolvent au
// lieu du zod 3 attendu (`z.function().args is not a function` → React ne
// monte jamais). L'AI SDK, lui, exige zod 4 (`zod/v4`, `zod/v4/core`).
// Ce script imbrique le zod 3.25.76 verrouillé sous chaque cible (copie dont
// la version est vérifiée), honorant le contrat peer déclaré. Idempotent,
// échoue bruyamment si aucune source zod 3.25.76. Exécuté en `postinstall`.
// Précédent : `pcb-mcp/scripts/fix-peer-zod.mjs` (ticket #40).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PEER_ZOD3_TARGETS = [
  "@tscircuit/eval",
  "@tscircuit/circuit-json-util",
  "@tscircuit/props",
  "@tscircuit/modelprinter",
  "@tscircuit/3d-viewer",
  "@tscircuit/schematic-viewer",
  "@tscircuit/schematic-viewer/node_modules/@tscircuit/circuit-json-util",
  "@tscircuit/schematic-viewer/node_modules/@tscircuit/props",
];

function readVersion(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** Cherche une copie zod 3.25.76 EXACTE déjà installée (core, footprinter…). */
export function findZod3Source(nmDir = path.join(root, "node_modules")) {
  if (!fs.existsSync(nmDir)) {
    throw new Error(`[pin-zod-v3] node_modules absent (${nmDir}) — lancer npm install d'abord`);
  }
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.name === "zod") {
        const v = readVersion(full);
        if (v) found.push({ dir: full, v });
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(nmDir, 0);
  const exact = found.find((f) => f.v === "3.25.76");
  if (exact) return exact.dir;
  throw new Error(
    `[pin-zod-v3] aucune source zod 3.25.76 exacte trouvée (vu : ${found.map((f) => f.v).join(", ") || "rien"})`,
  );
}

/** Imbrique zod 3.25.76 sous chaque cible. Retourne les chemins réparés. */
export function ensurePeerZod3(nmDir = path.join(root, "node_modules")) {
  const src = findZod3Source(nmDir);
  const fixed = [];
  for (const target of PEER_ZOD3_TARGETS) {
    const targetDir = path.join(nmDir, target);
    if (!fs.existsSync(targetDir)) continue; // Cible absente de cet arbre : rien à faire.
    const dest = path.join(targetDir, "node_modules", "zod");
    if (readVersion(dest) === "3.25.76") continue; // Déjà conforme.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    if (readVersion(dest) !== "3.25.76") {
      throw new Error(`[pin-zod-v3] copie vérifiée KO sous ${target}`);
    }
    fixed.push(`${target} → zod 3.25.76`);
  }
  return { source: src, fixed };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const res = ensurePeerZod3();
  for (const f of res.fixed) console.error(`[pin-zod-v3] ${f}`);
  if (res.fixed.length === 0) console.error("[pin-zod-v3] déjà conforme (zod 3.25.76 imbriqué)");
}
