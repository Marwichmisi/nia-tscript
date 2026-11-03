// Fixture board R1/R2+U1 (réutilisée du prototype preview-web, commit 83ab848).
// Le TSX reste la seule source de vérité (write-through) ; ce module ne fait
// que fournir le contenu initial + les stats circuit-json.

export const BOARD_CODE = `export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={-4} />
    <chip name="U1" footprint="sot23" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .pin1" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin3" to="net.VCC" />
  </board>
)
`;

export const ENTRYPOINT = "main.tsx";

/**
 * Routeur local tscircuit (ticket #44, recherche Context7 + état des lieux).
 * Variante locale `auto_local` (offline-first : aucun appel réseau, coût nul,
 * atomicité préservée) ; le routeur externe/cloud est écarté.
 * Effort configurable : `autorouterEffortLevel` tscircuit
 * ("1x" | "1.5x" | "2x" | "5x" | "10x" | "100x").
 */
export const ROUTE_EFFORTS = ["1x", "1.5x", "2x", "5x", "10x", "100x"] as const;
export type RouteEffort = (typeof ROUTE_EFFORTS)[number];
export const DEFAULT_ROUTE_EFFORT: RouteEffort = "1x";
export const LOCAL_AUTOROUTER_PRESET = "auto_local";

export function isRouteEffort(value: unknown): value is RouteEffort {
  return typeof value === "string" && (ROUTE_EFFORTS as readonly string[]).includes(value);
}

/** Tag `<board …>` d'ouverture (le TSX porte un seul board racine). */
function boardOpenTag(code: string): string | null {
  return code.match(/<board\b[^>]*>/)?.[0] ?? null;
}

/** `routingDisabled` déclaré sur le board → routage interdit, export refusé. */
export function boardRoutingDisabled(tsx: string): boolean {
  const tag = boardOpenTag(tsx);
  if (!tag) return false;
  return /\broutingDisabled\b/.test(tag);
}

/** Le TSX déclare des `<trace>` → un routage est attendu à l'export. */
export function boardExpectsRouting(tsx: string): boolean {
  return /<trace\b/.test(tsx);
}

export type AutorouterConfigResult = { ok: true; code: string } | { ok: false; message: string };

function setBoardAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(\\{[^}]*\\}|"[^"]*"|'[^']*')`);
  if (re.test(tag)) return tag.replace(re, `${name}="${value}"`);
  return tag.replace(/>$/, ` ${name}="${value}">`);
}

/**
 * Épingle le routeur local + effort sur le tag `<board>` (idempotent :
 * remplace la config existante au lieu de la dupliquer).
 * Échec si pas de `<board>` ou si `routingDisabled` est déclaré (l'agent
 * doit le retirer explicitement via patch, pas de contournement silencieux).
 */
export function withLocalAutorouter(code: string, effort: RouteEffort): AutorouterConfigResult {
  const tag = boardOpenTag(code);
  if (!tag) {
    return { ok: false, message: "route impossible : aucun tag <board …> dans le TSX" };
  }
  if (/\broutingDisabled\b/.test(tag)) {
    return {
      ok: false,
      message:
        "route impossible : routingDisabled déclaré sur <board> — retirez-le via code_patch avant de router",
    };
  }
  const next = setBoardAttr(
    setBoardAttr(tag, "autorouter", LOCAL_AUTOROUTER_PRESET),
    "autorouterEffortLevel",
    effort,
  );
  return { ok: true, code: code.replace(tag, next) };
}

/**
 * Preuve de routage effectif : au moins une `pcb_trace` avec un `route`
 * non vide. Un board `routingDisabled` ou à placement rouge ne route rien
 * (autoroutage ignoré par le moteur) → faux.
 */
export function isBoardRouted(circuitJson: unknown[]): boolean {
  for (const raw of circuitJson ?? []) {
    const el = (raw ?? {}) as Record<string, unknown>;
    if (el["type"] !== "pcb_trace") continue;
    if (Array.isArray(el["route"]) && el["route"].length > 0) return true;
  }
  return false;
}

/** Fixture preuve #13 : placement invalide (R1/R2 superposés en 0,0). */
export const BOARD_INVALID_PLACEMENT = `export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={0} pcbY={0} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={0} pcbY={0} />
    <chip name="U1" footprint="sot23" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .pin1" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin3" to="net.VCC" />
  </board>
)
`;

export function initialFsMap(): Record<string, string> {
  return { [ENTRYPOINT]: BOARD_CODE };
}

export interface CircuitStats {
  total: number;
  components: number;
  traces: number;
  nets: number;
  byType: Record<string, number>;
}

export function computeStats(circuitJson: unknown[]): CircuitStats {
  const byType: Record<string, number> = {};
  for (const el of circuitJson ?? []) {
    const t = (el as { type?: unknown })?.type;
    const key = typeof t === "string" ? t : "unknown";
    byType[key] = (byType[key] ?? 0) + 1;
  }
  const count = (re: RegExp) =>
    Object.entries(byType)
      .filter(([k]) => re.test(k))
      .reduce((a, [, v]) => a + (v as number), 0);
  return {
    total: (circuitJson ?? []).length,
    components: count(/pcb_component|schematic_component|cad_component|source_component/),
    traces: count(/pcb_trace|schematic_trace|source_trace/),
    nets: count(/source_net|pcb_net|schematic_net|cad_net/),
    byType,
  };
}

export function emptyStats(): CircuitStats {
  return { total: 0, components: 0, traces: 0, nets: 0, byType: {} };
}
