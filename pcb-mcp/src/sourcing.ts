// Sourcing JLCPCB-first — ticket #17 (spec #8, décision carte #6).
// API exacte validée via ctx7 (docs tscircuit + jlcsearch) :
//   - `tsci search --jlcpcb <query>` (alias --lcsc), `--json` pour le JSON.
//   - `tsci search --jlcpcb RP2040` → footprint `jlcpcb:C2040` copiable.
//   - `tsci import "C16040" --jlcpcb` (alias --lcsc, --tscircuit pour le registre).
// Le sidecar Bun reste offline-first (finding §10, phase 1 lib seule) : pas de
// binaire `tsci` embarqué, on interroge directement la même source
// (https://jlcsearch.tscircuit.com, GET /api/search?q= + GET
// /api/footprinter_strings/{lcsc}) puis fallback DSL footprinter local
// (@tscircuit/footprinter 0.0.450, sans réseau).
import { fp } from "@tscircuit/footprinter";

export const JLCSEARCH_BASE = "https://jlcsearch.tscircuit.com";

/** Commandes exactes validées (ctx7 : docs/command-line/tsci-search|import). */
export const TSCI_SEARCH_DOC = 'tsci search --jlcpcb "<query>" [--json] (alias --lcsc ; --kicad / --digikey / --mouser / --tscircuit pour les autres sources)';
export const TSCI_IMPORT_DOC = 'tsci import "<Cxxxx | nom | package>" --jlcpcb (alias --lcsc ; --tscircuit pour le registre, --download pour les modèles 3D)';

export const OFFLINE_SOURCING_BANNER =
  "RÉSEAU REQUIS hors-ligne — CDN désactivé (disableCdnLoading) : recherche JLCPCB indisponible, aucun résultat inventé.";

export type FootprintSource = "jlcpcb" | "footprinter" | "fallback-package";

export interface PartResult {
  lcsc: string;
  mfr: string;
  package: string;
  description: string;
  stock: number | null;
  /** Chaîne utilisable dans le TSX (`footprint="..."`). */
  footprint: string;
  footprinterString: string | null;
  footprintSource: FootprintSource;
  /** Snippet TSX minimal prêt à coller via `code_patch`. */
  tsxSnippet: string;
  /** Commande exacte équivalente côté CLI (API validée). */
  tsciImport: string;
}

export interface SearchPartsOk {
  ok: true;
  query: string;
  tsciSearch: string;
  results: PartResult[];
}

export interface SearchPartsErr {
  ok: false;
  query: string;
  tsciSearch: string;
  message: string;
  banner: string | null;
}

function tsciSearchCmd(query: string): string {
  return `tsci search --jlcpcb "${query}"`;
}

function tsciImportCmd(lcsc: string): string {
  return `tsci import "${lcsc}" --jlcpcb`;
}

function snippetFor(part: { lcsc: string; footprint: string; description: string }): string {
  const d = part.description.toLowerCase();
  const fpAttr = `footprint="${part.footprint}"`;
  if (d.includes("capacitor")) {
    return `<capacitor name="C?" capacitance="100nF" ${fpAttr} /> // ${part.lcsc}`;
  }
  if (d.includes("resistor")) {
    return `<resistor name="R?" resistance="10k" ${fpAttr} /> // ${part.lcsc}`;
  }
  if (d.includes("led")) {
    return `<led name="D?" ${fpAttr} /> // ${part.lcsc}`;
  }
  if (d.includes("diode")) {
    return `<diode name="D?" ${fpAttr} /> // ${part.lcsc}`;
  }
  return `<chip name="U?" ${fpAttr} /> // ${part.lcsc}`;
}

/** Valide une chaîne footprinter localement (sans réseau). null si invalide. */
function validateFootprint(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  try {
    fp.string(t);
    return t;
  } catch {
    return null;
  }
}

export interface GenerateFootprintOk {
  ok: true;
  footprint: string;
  padCount: number;
}

export interface GenerateFootprintErr {
  ok: false;
  message: string;
}

/**
 * Génère/valide un DSL footprinter et le "compile" (soup → pads).
 * Ex : "0402" → 5 éléments soup dont 2 pads. Throw → erreur exploitable.
 */
export function generateFootprintDsl(input: string): GenerateFootprintOk | GenerateFootprintErr {
  const t = (input ?? "").trim();
  if (!t) return { ok: false, message: "empreinte vide : précisez un DSL footprinter (ex 0402, 0603, sot23)" };
  try {
    const builder = fp.string(t) as { soup: () => Array<{ type?: string }> };
    const soup = builder.soup();
    const pads = soup.filter((e) => e.type === "pcb_smtpad" || e.type === "pcb_platedhole").length;
    return { ok: true, footprint: t, padCount: pads };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `DSL footprinter invalide "${t}" : ${message.slice(0, 200)}` };
  }
}

/**
 * Résout l'empreinte utilisable dans le TSX (critères #17-1/2).
 * Priorité : footprinter_string JLCPCB (cuivre IoU ≥ 95 %, compilé localement)
 * → package validé par le DSL local → DSL "0402" généré et compilé.
 * Ne retourne que des empreintes qui compilent (fp.string ne throw pas).
 */
export function resolveFootprint(
  pkg: string,
  footprinterString: string | null,
): { footprint: string; footprintSource: FootprintSource } {
  if (footprinterString && validateFootprint(footprinterString)) {
    return { footprint: footprinterString, footprintSource: "jlcpcb" };
  }
  const valid = validateFootprint(pkg);
  if (valid) {
    const gen = generateFootprintDsl(valid);
    if (gen.ok) return { footprint: gen.footprint, footprintSource: "fallback-package" };
  }
  const fallback = generateFootprintDsl("0402");
  // "0402" est un DSL canonique : ne peut pas échouer, garde-fou sinon.
  if (fallback.ok) return { footprint: fallback.footprint, footprintSource: "fallback-package" };
  return { footprint: "0402", footprintSource: "fallback-package" };
}

export interface SearchPartsOptions {
  limit?: number;
  disableCdnLoading?: boolean;
  fetchFn?: typeof fetch;
}

interface JlcComponent {
  lcsc?: unknown;
  mfr?: unknown;
  package?: unknown;
  description?: unknown;
  stock?: unknown;
}

/** Recherche JLCPCB-first (même source que `tsci search --jlcpcb`). */
export async function searchParts(
  query: string,
  opts?: SearchPartsOptions,
): Promise<SearchPartsOk | SearchPartsErr> {
  const q = (query ?? "").trim();
  const tsciSearch = tsciSearchCmd(q);
  if (!q) {
    return { ok: false, query: q, tsciSearch, message: "query vide : précisez un nom, une valeur ou une réf LCSC (ex 10k, 0402, C21190)", banner: null };
  }
  if (opts?.disableCdnLoading) {
    return {
      ok: false,
      query: q,
      tsciSearch,
      message: `${OFFLINE_SOURCING_BANNER} (query "${q}" non exécutée)`,
      banner: OFFLINE_SOURCING_BANNER,
    };
  }
  const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 10);
  const doFetch = opts?.fetchFn ?? fetch;
  let components: JlcComponent[];
  try {
    const res = await doFetch(`${JLCSEARCH_BASE}/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`jlcsearch HTTP ${res.status}`);
    const body = (await res.json()) as { components?: JlcComponent[] };
    components = Array.isArray(body.components) ? body.components : [];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, query: q, tsciSearch, message: `recherche JLCPCB impossible : ${message.slice(0, 200)} — réessayez en ligne ou via ${tsciSearch}`, banner: null };
  }
  const results: PartResult[] = [];
  for (const c of components.slice(0, limit)) {
    const lcscNum = Number(c.lcsc);
    if (!Number.isFinite(lcscNum) || lcscNum <= 0) continue;
    const lcsc = `C${Math.trunc(lcscNum)}`;
    const mfr = typeof c.mfr === "string" ? c.mfr : "";
    const pkg = typeof c.package === "string" ? c.package : "";
    const description = typeof c.description === "string" ? c.description : "";
    const stock = typeof c.stock === "number" && Number.isFinite(c.stock) ? c.stock : null;
    // Empreinte : footprinter_strings d'abord (cuivre IoU ≥ 95 %), fallback package.
    let footprinterString: string | null = null;
    try {
      const fr = await doFetch(`${JLCSEARCH_BASE}/api/footprinter_strings/${lcsc}`);
      if (fr.ok) {
        const fb = (await fr.json()) as {
          component_footprinter_details?: { footprinter_string?: unknown };
        };
        const s = fb.component_footprinter_details?.footprinter_string;
        if (typeof s === "string" && validateFootprint(s)) footprinterString = s;
      }
    } catch {
      // Best-effort : le fallback package prend le relais.
    }
    const { footprint, footprintSource } = resolveFootprint(pkg, footprinterString);
    const part = { lcsc, footprint, description };
    results.push({
      lcsc,
      mfr,
      package: pkg,
      description,
      stock,
      footprint,
      footprinterString,
      footprintSource,
      tsxSnippet: snippetFor(part),
      tsciImport: tsciImportCmd(lcsc),
    });
  }
  return { ok: true, query: q, tsciSearch, results };
}
