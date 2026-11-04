// Sourcing JLCPCB-first — ticket #17 (spec #8, décision carte #6).
// CŒUR T1 (#56) : logique pure + `searchParts` à `fetchFn` injecté (aucun
// accès réseau direct — l'hôte sidecar injecte `fetch`, le routeur agent
// injectera sa propre fonction). Extrait de `src/sourcing.ts` sans changer
// la logique.
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
  /** Guidance quand results est vide (index partiel), sinon null. */
  message: string | null;
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
    // fp.string ne fait que parser : la compilation réelle (qui rejette les
    // DSL farfelus) a lieu dans soup(). Valider = compiler.
    const builder = fp.string(t) as { soup: () => unknown[] };
    builder.soup();
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

export type FetchFn = typeof fetch;

export interface SearchPartsOptions {
  limit?: number;
  disableCdnLoading?: boolean;
  /** Injecté par l'hôte (sidecar : `fetch` global ; jamais d'accès réseau
   *  direct dans le cœur). Requis : sans lui, erreur explicite. */
  fetchFn: FetchFn;
}

interface JlcComponent {
  lcsc?: unknown;
  mfr?: unknown;
  package?: unknown;
  description?: unknown;
  stock?: unknown;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalise un package pour comparaison (sot-23 ≡ SOT23). */
function normPackage(s: string): string {
  return s.toLowerCase().replace(/[-_ ]/g, "");
}

const PACKAGE_HINT_RE =
  /\b(0201|0402|0603|0805|1206|1210|2010|2512|sot-?23|sot-?223|soic-?8|soic-?16|qfn-?\d*|lqfp-?\d*|tssop-?\d*|sod-?123|sod-?323|sod-?723)\b/i;

/**
 * Indices de pertinence extraits de la query : package (0402, SOT-23…),
 * token valeur (10k, 100nF… ; LCSC direct exclu) + famille devinée
 * (resistor/capacitor/inductor/diode d'après l'unité).
 */
export function parseQueryHints(query: string): {
  packageHint: string | null;
  valueToken: string | null;
  kindHint: string | null;
} {
  const tokens = query.split(/[\s,;]+/).filter(Boolean);
  let packageHint: string | null = null;
  let valueToken: string | null = null;
  for (const t of tokens) {
    if (!packageHint && PACKAGE_HINT_RE.test(t)) {
      packageHint = normPackage(t.match(PACKAGE_HINT_RE)![0]!);
      continue;
    }
    if (!valueToken && !/^c\d+$/i.test(t)) valueToken = t.toLowerCase();
  }
  let kindHint: string | null = null;
  if (valueToken) {
    if (/^\d+(\.\d+)?(p|n|u)f$/i.test(valueToken)) kindHint = "capacitor";
    else if (/^\d+(\.\d+)?(r|k|m|ohm)/i.test(valueToken)) kindHint = "resistor";
    else if (/^\d+(\.\d+)?(nh|uh|mh)$/i.test(valueToken)) kindHint = "inductor";
    else if (/led/i.test(valueToken)) kindHint = "led";
  }
  return { packageHint, valueToken, kindHint };
}

/** Score de pertinence : package exact > famille > valeur > stock. */
export function scorePart(
  part: { package: string; description: string; stock: number | null },
  hints: { packageHint: string | null; valueToken: string | null; kindHint: string | null },
): number {
  let score = 0;
  if (hints.packageHint) {
    const p = normPackage(part.package);
    if (p === hints.packageHint) score += 100;
    else if (p.includes(hints.packageHint) || hints.packageHint.includes(p)) score += 40;
  }
  const desc = part.description.toLowerCase();
  if (hints.kindHint) {
    if (hints.kindHint === "led") {
      if (desc.includes("led")) score += 50;
    } else if (desc.includes(hints.kindHint) || desc.includes(hints.kindHint.slice(0, 4))) {
      score += 50;
    }
  }
  if (hints.valueToken) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(hints.valueToken)}(?![a-z])`);
    if (re.test(desc) || re.test(part.package.toLowerCase())) score += 30;
  }
  if (typeof part.stock === "number" && part.stock > 0) score += 10;
  return score;
}

/** Détecte un timeout/abandon de fetch (AbortError, TimeoutError, message). */
function isTimeoutError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /timeout|timed out|abort/i.test(text);
}

/** Recherche JLCPCB-first (même source que `tsci search --jlcpcb`).
 *  `fetchFn` injecté par l'hôte (cœur sans réseau). */
export async function searchParts(
  query: string,
  opts: SearchPartsOptions,
): Promise<SearchPartsOk | SearchPartsErr> {
  const q = (query ?? "").trim();
  const tsciSearch = tsciSearchCmd(q);
  if (!q) {
    return { ok: false, query: q, tsciSearch, message: "query vide : précisez un nom, une valeur ou une réf LCSC (ex 10k, 0402, C21190)", banner: null };
  }
  if (!opts?.fetchFn) {
    return {
      ok: false,
      query: q,
      tsciSearch,
      message: `recherche JLCPCB impossible : fetchFn non injecté (cœur sans réseau) — l'hôte doit fournir la fonction de fetch, ou ${tsciSearch}`,
      banner: null,
    };
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
  const doFetch = opts.fetchFn;
  let components: JlcComponent[];
  try {
    const res = await doFetch(`${JLCSEARCH_BASE}/api/search?q=${encodeURIComponent(q)}`);
    if (res.status === 429) {
      return {
        ok: false,
        query: q,
        tsciSearch,
        message:
          `jlcsearch saturé (HTTP 429 — quota/rate-limit) pour "${q}" : ` +
          `patientez quelques secondes puis réessayez, ou ${tsciSearch}`,
        banner: null,
      };
    }
    if (!res.ok) {
      if (res.status >= 500 && res.status <= 599) {
        return {
          ok: false,
          query: q,
          tsciSearch,
          message:
            `jlcsearch indisponible (HTTP ${res.status} — erreur serveur) pour "${q}" : ` +
            `réessayez plus tard, ou ${tsciSearch}`,
          banner: null,
        };
      }
      throw new Error(`jlcsearch HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        query: q,
        tsciSearch,
        message: `réponse jlcsearch illisible (JSON invalide) pour "${q}" : réessayez, ou ${tsciSearch}`,
        banner: null,
      };
    }
    const parsed = body as { components?: JlcComponent[] };
    components = Array.isArray(parsed.components) ? parsed.components : [];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/^jlcsearch HTTP/.test(message)) {
      return { ok: false, query: q, tsciSearch, message: `recherche JLCPCB impossible : ${message.slice(0, 200)} — réessayez en ligne ou via ${tsciSearch}`, banner: null };
    }
    if (isTimeoutError(e)) {
      return {
        ok: false,
        query: q,
        tsciSearch,
        message: `recherche JLCPCB interrompue (timeout) pour "${q}" : réseau trop lent ou jointure coupée — réessayez, ou ${tsciSearch}`,
        banner: null,
      };
    }
    return { ok: false, query: q, tsciSearch, message: `recherche JLCPCB impossible : ${message.slice(0, 200)} — réessayez en ligne ou via ${tsciSearch}`, banner: null };
  }
  // Pertinence : l'index générique rend des résultats flous (mauvais package
  // en premier, intrus). On ranke avant de tronquer à `limit`.
  const hints = parseQueryHints(q);
  const ranked = [...components]
    .map((c, i) => {
      const pkg = typeof c.package === "string" ? c.package : "";
      const description = typeof c.description === "string" ? c.description : "";
      const stock = typeof c.stock === "number" && Number.isFinite(c.stock) ? c.stock : null;
      return {
        c,
        i,
        score: scorePart({ package: pkg, description, stock }, hints),
        stockRank: stock ?? -1,
      };
    })
    .sort((a, b) => b.score - a.score || b.stockRank - a.stockRank || a.i - b.i)
    .map((r) => r.c);
  const results: PartResult[] = [];
  for (const c of ranked.slice(0, limit)) {
    const lcscNum = Number(c.lcsc);
    if (!Number.isFinite(lcscNum) || lcscNum <= 0) continue;
    const lcsc = `C${Math.trunc(lcscNum)}`;
    const mfr = typeof c.mfr === "string" ? c.mfr : "";
    const pkg = typeof c.package === "string" ? c.package : "";
    const description = typeof c.description === "string" ? c.description : "";
    let stock = typeof c.stock === "number" && Number.isFinite(c.stock) ? c.stock : null;
    // Stock parfois null sur /api/search : enrichi via components/list.json.
    if (stock === null) {
      try {
        const sr = await doFetch(`${JLCSEARCH_BASE}/components/list.json?search=${lcsc}`);
        if (sr.ok) {
          const sb = (await sr.json()) as { components?: JlcComponent[] };
          const match = (Array.isArray(sb.components) ? sb.components : []).find(
            (x) => Number(x.lcsc) === lcscNum,
          );
          const s = match?.stock;
          if (typeof s === "number" && Number.isFinite(s)) stock = s;
        }
      } catch {
        // Best-effort : stock reste null, le résultat reste utilisable.
      }
    }
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
  if (results.length === 0) {
    return {
      ok: true,
      query: q,
      tsciSearch,
      results,
      message:
        `aucun résultat JLCPCB pour "${q}" (l'index générique ne couvre pas tout, ex certains MCU) : ` +
        `précisez valeur + package (ex 10k 0402) ou une réf LCSC directe (ex C21190), ou ${tsciSearch}`,
    };
  }
  return { ok: true, query: q, tsciSearch, results, message: null };
}
