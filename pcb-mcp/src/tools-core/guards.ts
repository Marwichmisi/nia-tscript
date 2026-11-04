// Gardes Confinement du cœur (T1, #56) : logique pure, effets injectés.
// Extrait de `src/mcp.ts` sans changer la logique. `resolveProject` et
// `isMember` viennent de `ToolsDeps` (hôte : lockfile + Registre disque).
import { NO_PROJECT_OPEN, OUT_OF_SCOPE } from "./project-core.js";
import type { ToolsDeps } from "./deps.js";

export function noProjectError(code: string): { message: string; code: string } {
  return {
    message: `aucun projet ouvert : ouvre un projet dans l'app ou via project_open (${code})`,
    code: NO_PROJECT_OPEN,
  };
}

/** Confinement (ticket #42) : le Projet résolu par l'hôte doit être membre
 *  du Registre. Retourne `null` si le contrôle passe, sinon l'erreur
 *  explicite hors périmètre (à fusionner dans la sortie de refus de
 *  l'outil, comme `noProjectError`).
 *  `null` projet → `null` aussi (l'appelant garde son `NO_PROJECT_OPEN`). */
export function checkConfined(
  tool: string,
  proj: string | null,
  assertMember: (projectPath: string) => string,
): { message: string; code: string } | null {
  if (!proj) return null;
  try {
    assertMember(proj);
    return null;
  } catch (e) {
    return { message: `${(e as Error).message} (${tool})`, code: OUT_OF_SCOPE };
  }
}

/** Préambule Confinement mutualisé (revue #37 item 11) : Projet résolu par
 *  l'hôte + contrôle d'appartenance. */
export function requireConfinedProject(
  tool: string,
  deps: Pick<ToolsDeps, "resolveProject" | "assertMember">,
): {
  proj: string | null;
  scopeErr: { message: string; code: string } | null;
} {
  const proj = deps.resolveProject();
  return { proj, scopeErr: checkConfined(tool, proj, deps.assertMember) };
}
