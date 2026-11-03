// Gate first-party (revue #37 item 5) : ÉCHOUE sur toute erreur tsc dans les
// fichiers du repo (src/|scripts/|test/), ignore les erreurs tierces
// (node_modules — ex sources .ts brutes de @tscircuit/fanout-solver, dette
// #40 ; le `tsc --noEmit` complet reste informatif en CI).
// Usage : `bun scripts/check-types.mjs` (cwd = pcb-mcp). Bloquant.
// Testé par pcb-mcp/test/build-repro.test.ts (filtre + câblage CI).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIRST_PARTY_DIRS = ["src/", "scripts/", "test/"];

/**
 * Trie une sortie `tsc --noEmit` : erreurs du repo vs tierces.
 * Les chemins contenant `node_modules` (install réelle comme symlink local
 * vers un autre worktree) sont toujours tierces.
 */
export function filterFirstPartyErrors(tscOutput) {
  const firstParty = [];
  let thirdParty = 0;
  for (const line of String(tscOutput ?? "").split("\n")) {
    const m = line.match(/^([^(]+?)\(\d+,\d+\): error TS\d+:/);
    if (!m) continue;
    const p = m[1].trim().replace(/\\/g, "/");
    if (p.includes("node_modules")) {
      thirdParty++;
      continue;
    }
    if (FIRST_PARTY_DIRS.some((d) => p === d.slice(0, -1) || p.startsWith(d))) {
      firstParty.push(line);
    } else {
      thirdParty++;
    }
  }
  return { firstParty, thirdParty };
}

function tscBin(pcbMcpRoot) {
  const local = path.join(
    pcbMcpRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  return local;
}

function runGate() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const pcbMcp = path.dirname(root);
  let output = "";
  try {
    output = execFileSync(tscBin(pcbMcp), ["--noEmit"], {
      cwd: pcbMcp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // tsc sort non-zéro dès qu'il y a des erreurs : la sortie reste exploitable.
    output = typeof e?.stdout === "string" ? e.stdout : String(e?.stdout ?? e?.message ?? e);
  }
  const { firstParty, thirdParty } = filterFirstPartyErrors(output);
  if (firstParty.length > 0) {
    console.error(`[check-types] REFUSÉ : ${firstParty.length} erreur(s) first-party :`);
    for (const line of firstParty) console.error(`  ${line}`);
    console.error(`[check-types] (${thirdParty} erreur(s) tierce(s) ignorée(s), dette #40)`);
    process.exit(1);
  }
  console.error(`[check-types] ok : 0 erreur first-party (${thirdParty} tierce(s) ignorée(s))`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runGate();
}
