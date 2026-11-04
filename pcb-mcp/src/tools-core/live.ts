// Mutations live restreintes (pures, sans I/O) — ticket #14.
// Write-through : chaque op réécrit le TSX ; la recompile est faite par
// l'appelant (mcp.ts) après `setCode`. Création/suppression refusées
// (renvoi vers `code_patch`, spec #8 règles métier).

export interface LiveOk {
  ok: true;
  code: string;
}

export interface LiveErr {
  ok: false;
  message: string;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TRACE_RE_SRC = `<trace\\b(?:[^>"']|"[^"]*"|'[^']*')*>`;
const TRACE_RE = new RegExp(TRACE_RE_SRC, "g");

function findComponentTag(code: string, refdes: string): { tag: string; index: number } | null {
  const re = new RegExp(
    `<[A-Za-z][\\w-]*(?:[^>"']|"[^"]*"|'[^']*')*\\bname\\s*=\\s*"${escapeRegExp(refdes)}"(?:[^>"']|"[^"]*"|'[^']*')*\\/?>`,
    "g",
  );
  const matches = [...code.matchAll(re)];
  if (matches.length === 0) return null;
  // Prend la première occurrence (name unique imposé par le format §8).
  const m = matches[0]!;
  return { tag: m[0], index: m.index ?? 0 };
}

function setNumericProp(tag: string, prop: string, value: number): string {
  const re = new RegExp(`\\b${escapeRegExp(prop)}\\s*=\\s*(\\{[^}]*\\}|"[^"]*"|'[^']*'|[^\\s/>]+)`);
  const replacement = `${prop}={${value}}`;
  if (re.test(tag)) return tag.replace(re, replacement);
  if (tag.endsWith("/>")) return tag.slice(0, -2).trimEnd() + ` ${replacement} />`;
  if (tag.endsWith(">")) return tag.slice(0, -1).trimEnd() + ` ${replacement}>`;
  return `${tag} ${replacement}`;
}

function setStringProp(tag: string, prop: string, value: string): string {
  const re = new RegExp(`\\b${escapeRegExp(prop)}\\s*=\\s*(\\{[^}]*\\}|"[^"]*"|'[^']*'|[^\\s/>]+)`);
  const replacement = `${prop}="${value}"`;
  if (re.test(tag)) return tag.replace(re, replacement);
  if (tag.endsWith("/>")) return tag.slice(0, -2).trimEnd() + ` ${replacement} />`;
  if (tag.endsWith(">")) return tag.slice(0, -1).trimEnd() + ` ${replacement}>`;
  return `${tag} ${replacement}`;
}

function replaceTag(code: string, oldTag: string, index: number, newTag: string): string {
  return code.slice(0, index) + newTag + code.slice(index + oldTag.length);
}

export function applyMove(code: string, refdes: string, x: number, y: number): LiveOk | LiveErr {
  if (!refdes) return { ok: false, message: "refdes vide : précisez le composant (ex R1)" };
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, message: `coordonnées invalides x=${x} y=${y} : nombres finis exigés` };
  }
  const found = findComponentTag(code, refdes);
  if (!found) return { ok: false, message: `composant ${refdes} introuvable dans le TSX` };
  let tag = setNumericProp(found.tag, "pcbX", x);
  tag = setNumericProp(tag, "pcbY", y);
  return { ok: true, code: replaceTag(code, found.tag, found.index, tag) };
}

export function applyRotate(code: string, refdes: string, degrees: number): LiveOk | LiveErr {
  if (!refdes) return { ok: false, message: "refdes vide : précisez le composant (ex R1)" };
  if (!Number.isFinite(degrees)) {
    return { ok: false, message: `rotation invalide degrees=${degrees} : nombre fini exigé` };
  }
  const found = findComponentTag(code, refdes);
  if (!found) return { ok: false, message: `composant ${refdes} introuvable dans le TSX` };
  const tag = setNumericProp(found.tag, "pcbRotation", degrees);
  return { ok: true, code: replaceTag(code, found.tag, found.index, tag) };
}

export function applySwapPackage(
  code: string,
  refdes: string,
  footprint: string,
): LiveOk | LiveErr {
  if (!refdes) return { ok: false, message: "refdes vide : précisez le composant (ex R1)" };
  if (!footprint || !footprint.trim()) {
    return { ok: false, message: "footprint vide : précisez l'empreinte (ex 0603)" };
  }
  const found = findComponentTag(code, refdes);
  if (!found) return { ok: false, message: `composant ${refdes} introuvable dans le TSX` };
  const tag = setStringProp(found.tag, "footprint", footprint.trim());
  return { ok: true, code: replaceTag(code, found.tag, found.index, tag) };
}

function normNet(net: string): string {
  const t = net.trim();
  return t.startsWith("net.") ? t : `net.${t}`;
}

function traceEndpoints(tag: string): { from: string; to: string } | null {
  const from = tag.match(/\bfrom\s*=\s*"([^"]+)"/)?.[1];
  const to = tag.match(/\bto\s*=\s*"([^"]+)"/)?.[1];
  if (from === undefined || to === undefined) return null;
  return { from, to };
}

function touchesPin(endpoint: string, refdes: string, pin: string): boolean {
  // Sélecteur exact `.REF > .pin` (espaces tolérées) : évite les faux
  // positifs par préfixe (R1 vs R10, pin1 vs pin10).
  const re = new RegExp(
    `\\.${escapeRegExp(refdes)}\\s*>\\s*\\.${escapeRegExp(pin)}(?![A-Za-z0-9_])`,
  );
  return re.test(endpoint);
}

export function applyReassignNet(
  code: string,
  refdes: string,
  pin: string,
  net: string,
): LiveOk | LiveErr {
  if (!refdes || !pin) {
    return { ok: false, message: "refdes/pin vides : précisez (ex R1, pin1)" };
  }
  if (!net || !net.trim()) {
    return { ok: false, message: "net vide : précisez le net cible (ex GND)" };
  }
  const target = normNet(net);
  const matches = [...code.matchAll(TRACE_RE)];
  const touching = matches.filter((m) => {
    const ep = traceEndpoints(m[0]);
    if (!ep) return false;
    return touchesPin(ep.from, refdes, pin) || touchesPin(ep.to, refdes, pin);
  });
  if (touching.length === 0) {
    return {
      ok: false,
      message:
        `aucune trace trouvée pour ${refdes}.${pin} : vérifiez refdes/pin ou utilisez code_patch`,
    };
  }
  const withNet = touching.filter((m) => {
    const ep = traceEndpoints(m[0])!;
    const fromTouches = touchesPin(ep.from, refdes, pin);
    const toTouches = touchesPin(ep.to, refdes, pin);
    // Trace pin-pin des deux côtés : pas de côté net à réassigner.
    if (fromTouches && toTouches) return false;
    const opposite = fromTouches ? ep.to : ep.from;
    return opposite.trim().startsWith("net.");
  });
  if (withNet.length === 0) {
    return {
      ok: false,
      message:
        `aucune trace net trouvée pour ${refdes}.${pin} (liaison pin-pin : réécrivez la topologie via code_patch)`,
    };
  }
  let next = code;
  // Réécrit en partant de la fin pour garder les index valides.
  const ordered = [...withNet].sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
  for (const m of ordered) {
    const tag = m[0];
    const idx = m.index ?? 0;
    const ep = traceEndpoints(tag)!;
    const fromTouches = touchesPin(ep.from, refdes, pin);
    const side: "from" | "to" = fromTouches ? "to" : "from";
    const re = new RegExp(`\\b${side}\\s*=\\s*"[^"]*"`);
    const patched = tag.replace(re, `${side}="${target}"`);
    next = next.slice(0, idx) + patched + next.slice(idx + tag.length);
  }
  return { ok: true, code: next };
}

export interface Selection {
  refdes: string;
  pkg: string;
  value: string;
  rotation: number;
  nets: string[];
}

function propString(tag: string, prop: string): string | null {
  const m = tag.match(new RegExp(`\\b${escapeRegExp(prop)}\\s*=\\s*"([^"]*)"`));
  return m?.[1] ?? null;
}

function propNumber(tag: string, prop: string): number | null {
  const m = tag.match(new RegExp(`\\b${escapeRegExp(prop)}\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function getSelection(code: string, refdes: string): Selection | null {
  const found = findComponentTag(code, refdes);
  if (!found) return null;
  const tag = found.tag;
  const pkg = propString(tag, "footprint") ?? propString(tag, "pkg") ?? "";
  const value =
    propString(tag, "resistance") ??
    propString(tag, "capacitance") ??
    propString(tag, "value") ??
    "";
  const rotation = propNumber(tag, "pcbRotation") ?? 0;
  const nets = new Set<string>();
  const refRe = new RegExp(`\\.${escapeRegExp(refdes)}(?![A-Za-z0-9_])`);
  for (const m of code.matchAll(TRACE_RE)) {
    const ep = traceEndpoints(m[0]);
    if (!ep) continue;
    for (const side of [ep.from, ep.to] as const) {
      if (refRe.test(side)) {
        const other = side === ep.from ? ep.to : ep.from;
        // Net explicite net.X ou pin d'un autre composant : on retient le net
        // quand il est explicite, sinon la cible brute (topologie pin-pin).
        const netMatch = other.match(/net\.([A-Za-z0-9_+-]+)/) ?? side.match(/net\.([A-Za-z0-9_+-]+)/);
        if (netMatch?.[1]) nets.add(netMatch[1]!);
      }
    }
  }
  return { refdes, pkg, value, rotation, nets: [...nets].sort() };
}

export function listViews(): string[] {
  return ["schema", "pcb", "3d"];
}

/** Message de refus canonique pour toute création/suppression live. */
export function refuseLiveCreation(op: string): string {
  return (
    `opération live "${op}" refusée : création/suppression via live non supportée ` +
    `(live V1 restreinte à move | rotate | swap_package | reassign_net + sélection/vues) — ` +
    `utilisez code_patch avec une ancre exacte du TSX`
  );
}

/** Ops live acceptées (tiroir live_manage). */
export const LIVE_OPS = [
  "move",
  "rotate",
  "swap_package",
  "reassign_net",
  "select",
  "view",
] as const;

export type LiveOpName = (typeof LIVE_OPS)[number];

/** Ops explicitement refusées avec renvoi vers code_patch. */
export const REFUSED_LIVE_OPS = ["create", "add", "delete", "remove"] as const;
