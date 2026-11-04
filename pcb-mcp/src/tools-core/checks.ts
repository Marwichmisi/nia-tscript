// Checks natifs + gate placement dur — ticket #13.
// CŒUR T1 (#56) : logique inchangée ; `@tscircuit/checks` est du pur JS
// (pas de node:) donc importable ici. Les outils du cœur appellent ces
// fonctions via `ToolsDeps.checks` (injectable : l'hôte peut substituer,
// ex. commandes Tauri côté agent intégré).
// Natif : `@tscircuit/checks` (runAll*Checks, checkPcbTraceStyle) sur le
// circuit-json issu de la compile injectée. Le gate exige en PLUS des
// coordonnées explicites pcbX/pcbY dans le TSX (le placeur auto masque les
// oublis : un composant sans coords compile vert mais n'est pas « vert »
// au sens gate).
import {
  checkPcbTraceStyle,
  runAllNetlistChecks,
  runAllPlacementChecks,
  runAllRoutingChecks,
  runAllSchematicChecks,
} from "@tscircuit/checks";

export type CheckDomain = "netlist" | "placement" | "routing" | "style" | "all";

export interface PositionedViolation {
  domain: Exclude<CheckDomain, "all">;
  type: string;
  message: string;
  x: number | null;
  y: number | null;
  refdes: string | null;
}

export interface PlacementGate {
  placementGreen: boolean;
  routingAllowed: boolean;
  missingCoords: string[];
  placementViolations: PositionedViolation[];
  /** Raison explicite quand routingAllowed === false (gate dur). */
  blockReason: string | null;
}

// Extrait la position d'une violation native (formes constatées :
// center {x,y}, component_center {x,y}, tracePoint, obstaclePoint).
function extractPosition(v: Record<string, unknown>): { x: number | null; y: number | null } {
  const candidates = [
    v["center"],
    v["component_center"],
    v["tracePoint"],
    v["obstaclePoint"],
  ];
  for (const c of candidates) {
    if (
      c !== null &&
      typeof c === "object" &&
      typeof (c as { x?: unknown }).x === "number" &&
      typeof (c as { y?: unknown }).y === "number"
    ) {
      return { x: (c as { x: number }).x, y: (c as { y: number }).y };
    }
  }
  return { x: null, y: null };
}

function extractRefdes(v: Record<string, unknown>): string | null {
  const msg = typeof v["message"] === "string" ? v["message"] : "";
  const m = msg.match(/\b([RCULDJQ][A-Z]?\d+)\b/);
  return m?.[1] ?? null;
}

function normalize(domain: PositionedViolation["domain"], list: unknown[]): PositionedViolation[] {
  const out: PositionedViolation[] = [];
  const visit = (raw: unknown) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    // Les chevauchements portent leurs positions dans `related_errors`
    // (pads en collision avec center) : on les aplatit pour que chaque
    // violation positionnée soit lisible par l'agent.
    const related = v["related_errors"];
    if (Array.isArray(related)) {
      for (const r of related) visit(r);
    }
    const { x, y } = extractPosition(v);
    const type =
      typeof v["type"] === "string"
        ? (v["type"] as string)
        : typeof v["error_type"] === "string"
          ? (v["error_type"] as string)
          : "unknown";
    const message =
      typeof v["message"] === "string" ? (v["message"] as string) : JSON.stringify(raw).slice(0, 300);
    // Le conteneur d'un chevauchement n'a ni message propre ni position :
    // seules ses related_errors positionnées sont exploitables par l'agent.
    if (Array.isArray(related) && related.length > 0 && x === null && y === null) {
      return;
    }
    out.push({ domain, type, message, x, y, refdes: extractRefdes(v) });
  };
  for (const raw of list ?? []) visit(raw);
  return out;
}

/** Composants TSX sans pcbX/pcbY explicites (gate dur : coordonnées exigées). */
export function findMissingCoords(tsx: string): string[] {
  const missing: string[] = [];
  // Balises feuille portant un name="..." (resistor, chip, capacitor, …).
  const tagRe = /<(?:resistor|capacitor|inductor|diode|led|chip|transistor|crystal|jumper|testpoint|pinheader|resonator|pushbutton|switch|potentiometer|transformer|fuse|mosfet)\b[^>]*>/gi;
  for (const m of tsx.matchAll(tagRe)) {
    const tag = m[0];
    const name = tag.match(/\bname\s*=\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const hasX = /\bpcbX\s*=/.test(tag);
    const hasY = /\bpcbY\s*=/.test(tag);
    if (!hasX || !hasY) missing.push(name);
  }
  return [...new Set(missing)].sort();
}

export async function runPlacementGate(
  circuitJson: unknown[],
  tsx: string,
): Promise<PlacementGate> {
  const raw = await runAllPlacementChecks(circuitJson as never[]);
  const placementViolations = normalize("placement", raw as unknown[]);
  const missingCoords = findMissingCoords(tsx);
  const placementGreen = placementViolations.length === 0 && missingCoords.length === 0;
  let blockReason: string | null = null;
  if (!placementGreen) {
    if (missingCoords.length > 0) {
      blockReason =
        `placement non vert : coordonnées explicites manquantes (pcbX/pcbY) sur ${missingCoords.join(", ")} ` +
        `— ajoutez pcbX={…} pcbY={…} à chaque composant avant tout routing`;
    } else {
      blockReason =
        `placement non vert : ${placementViolations.length} violation(s) placement ` +
        `(${placementViolations[0]?.type ?? "inconnu"} : ${placementViolations[0]?.message ?? ""}) — corrigez le placement avant tout routing`;
    }
  }
  return {
    placementGreen,
    routingAllowed: placementGreen,
    missingCoords,
    placementViolations,
    blockReason,
  };
}

export async function runDomainChecks(
  circuitJson: unknown[],
  domain: CheckDomain,
): Promise<PositionedViolation[]> {
  const cj = circuitJson as never[];
  switch (domain) {
    case "netlist":
      return normalize("netlist", (await runAllNetlistChecks(cj)) as unknown[]);
    case "placement":
      return normalize("placement", (await runAllPlacementChecks(cj)) as unknown[]);
    case "routing":
      return normalize("routing", (await runAllRoutingChecks(cj)) as unknown[]);
    case "style": {
      const pcb = checkPcbTraceStyle(cj) as unknown[];
      const sch = (await runAllSchematicChecks(cj)) as unknown[];
      return [...normalize("style", pcb), ...normalize("style", sch)];
    }
    case "all": {
      const [n, p, r, sch] = await Promise.all([
        runAllNetlistChecks(cj),
        runAllPlacementChecks(cj),
        runAllRoutingChecks(cj),
        runAllSchematicChecks(cj),
      ]);
      const pcbStyle = checkPcbTraceStyle(cj) as unknown[];
      return [
        ...normalize("netlist", n as unknown[]),
        ...normalize("placement", p as unknown[]),
        ...normalize("routing", r as unknown[]),
        ...normalize("style", pcbStyle),
        ...normalize("style", sch as unknown[]),
      ];
    }
  }
}
