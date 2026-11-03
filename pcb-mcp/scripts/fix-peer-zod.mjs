// Ticket #40 — bun ne matérialise pas les peers zod 3 des paquets tscircuit
// (eval, circuit-json-util, props, modelprinter : peer `3`/`^3`/`*` mais code
// appelant l'API zod 3 `z.function().args()`, absente de zod 4) : ils
// résolvent le zod 4 hoisté → TOUTES les compiles tscircuit échouent
// (`z179.function().args is not a function`, constat impl-39).
// Ce script imbrique le zod 3.25.76 verrouillé sous ces paquets (copie dont
// la version major est vérifiée == 3), honorant le contrat peer déclaré.
// Idempotent, échoue bruyamment si aucune source zod 3 (verrouillée) existe.
// Exécuté en `postinstall` et en step CI explicite (ceinture et bretelles).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PEER_ZOD3_TARGETS = [
  "@tscircuit/eval",
  "@tscircuit/circuit-json-util",
  "@tscircuit/props",
  "@tscircuit/modelprinter",
];

function readVersion(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** Cherche une copie zod major 3 déjà installée (imbrications core, etc.). */
export function findZod3Source(nmDir = path.join(root, "node_modules")) {
  if (!fs.existsSync(nmDir)) {
    throw new Error(`[fix-peer-zod] node_modules absent (${nmDir}) — lancer bun install d'abord`);
  }
  for (const entry of fs.readdirSync(nmDir)) {
    const scopes = entry.startsWith("@")
      ? fs.readdirSync(path.join(nmDir, entry)).map((s) => path.join(entry, s))
      : [entry];
    for (const cand of scopes) {
      const zodDir = path.join(nmDir, cand, "node_modules", "zod");
      const v = readVersion(zodDir);
      if (v?.startsWith("3.")) return zodDir;
    }
  }
  throw new Error("[fix-peer-zod] aucune source zod 3 verrouillée trouvée dans node_modules");
}

/** Imbrique zod 3 sous chaque cible peer. Retourne les chemins réparés. */
export function ensurePeerZod3(nmDir = path.join(root, "node_modules")) {
  const src = findZod3Source(nmDir);
  const srcVersion = readVersion(src);
  const fixed = [];
  for (const target of PEER_ZOD3_TARGETS) {
    const dest = path.join(nmDir, target, "node_modules", "zod");
    if (!fs.existsSync(path.join(nmDir, target))) {
      throw new Error(`[fix-peer-zod] cible absente : ${target} (install incomplète ?)`);
    }
    if (readVersion(dest)?.startsWith("3.")) continue; // Déjà conforme.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    const v = readVersion(dest);
    if (!v?.startsWith("3.")) {
      throw new Error(`[fix-peer-zod] copie vérifiée KO sous ${target} (version=${v})`);
    }
    fixed.push(`${target} → zod ${v} (source ${srcVersion})`);
  }
  return { source: `${src} (${srcVersion})`, fixed };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const res = ensurePeerZod3();
  for (const f of res.fixed) console.error(`[fix-peer-zod] ${f}`);
  if (res.fixed.length === 0) console.error("[fix-peer-zod] déjà conforme (zod 3 imbriqué)");
}
