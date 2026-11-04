// Patch TSX ancré (pur, sans I/O).
// Règle : l'ancre doit apparaître EXACTEMENT une fois dans le code.
// 0 occurrence → erreur "ancre introuvable" ; >1 → erreur "ancre ambiguë"
// avec le nombre d'occurrences (diagnostic exploitable par l'agent).

export interface PatchOk {
  ok: true;
  code: string;
}

export interface PatchErr {
  ok: false;
  occurrences: number;
  message: string;
}

export function countOccurrences(code: string, anchor: string): number {
  if (!anchor) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = code.indexOf(anchor, from);
    if (idx < 0) break;
    count += 1;
    from = idx + anchor.length;
  }
  return count;
}

export function applyAnchoredPatch(
  code: string,
  anchor: string,
  replacement: string,
): PatchOk | PatchErr {
  if (!anchor) {
    return { ok: false, occurrences: 0, message: "ancre vide : fournissez un extrait exact du TSX" };
  }
  const occurrences = countOccurrences(code, anchor);
  if (occurrences === 0) {
    return {
      ok: false,
      occurrences,
      message: `ancre introuvable (0 occurrence) : vérifiez l'extrait exact du TSX`,
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      occurrences,
      message: `ancre ambiguë (${occurrences} occurrences) : précisez l'extrait pour viser une seule occurrence`,
    };
  }
  return { ok: true, code: code.replace(anchor, replacement) };
}
