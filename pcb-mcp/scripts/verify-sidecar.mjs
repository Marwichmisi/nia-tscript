// Ticket #40 — vérification du sidecar pcb-mcp après compilation.
// Spec #37 : « vérification taille + permissions du sidecar après compilation »,
// « refus si world-writable ou stub sous le seuil de taille réelle ».
// Seuil : 1 Mio. Le stub scripts/ensure-sidecar-stub.sh pèse ≈ 150 o ;
// un `bun build --compile` du serveur (tscircuit + deps embarquées) pèse des
// dizaines de Mo. 1 Mio est donc ~7000× au-dessus du stub et reste très en
// dessous de tout binaire réel : aucun faux refus, aucun stub accepté.
// Usage : `bun scripts/verify-sidecar.mjs [chemin-binaire]`
// (chemin par défaut : src-tauri/binaries/pcb-mcp-<triple-hôte>[.exe]).
// Utilisé par pcb-mcp/scripts/build.mjs après compilation et par la CI.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_SIDECAR_BYTES = 1_048_576;

export function defaultSidecarPath() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const repoRoot = path.dirname(root);
  const triple = (process.env.TARGET_TRIPLE ?? execSync("rustc --print host-tuple").toString().trim());
  if (!triple) throw new Error("[verify-sidecar] triple vide (rustc --print host-tuple)");
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(repoRoot, "src-tauri", "binaries", `pcb-mcp-${triple}${ext}`);
}

/** Refus world-writable : POSIX uniquement. Sur Windows, Node émule le mode
 *  (0o666 systématique) sans sémantique POSIX — le refus y serait un faux
 *  positif permanent ; l'exécutabilité y est portée par les ACL NTFS et le
 *  bundler Tauri. Le garde taille (anti-stub) reste actif partout. */
export function shouldRefuseWorldWritable(mode, platform = process.platform) {
  if (platform === "win32") return false;
  return (mode & 0o002) !== 0;
}

/** Vérifie taille + permissions. Retourne { path, size, worldWritable: false }. Lève sinon. */
export function verifySidecar(target = defaultSidecarPath()) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    throw new Error(`[verify-sidecar] sidecar introuvable : ${target} (compiler d'abord via bun scripts/build.mjs)`);
  }
  if (st.size < MIN_SIDECAR_BYTES) {
    throw new Error(
      `[verify-sidecar] sidecar stub ou tronqué : ${target} (${st.size} octets < seuil ${MIN_SIDECAR_BYTES})`,
    );
  }
  if (shouldRefuseWorldWritable(st.mode)) {
    throw new Error(`[verify-sidecar] permissions refusées (world-writable) : ${target}`);
  }
  return { path: target, size: st.size, worldWritable: false };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const res = verifySidecar(process.argv[2]);
  console.error(`[verify-sidecar] ok : ${res.path} (${res.size} octets, non world-writable)`);
}
