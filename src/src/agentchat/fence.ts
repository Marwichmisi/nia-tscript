// Protocole de lot (pur) : voir en-tête du test (émulation prompt du
// tool-calling, backend T4 texte seul).

const FENCE_OPEN = "```batch_execute";
const FENCE_CLOSE = "```";

/** Vrai si le texte contient un bloc lot proposé par le modèle. */
export function hasBatchFence(text: string): boolean {
  return text.includes(FENCE_OPEN);
}

/** Extrait le JSON du premier bloc lot, `null` si absent ou mal formé. */
export function extractBatchFence(text: string): string | null {
  const start = text.indexOf(FENCE_OPEN);
  if (start < 0) return null;
  const afterOpen = start + FENCE_OPEN.length;
  const end = text.indexOf(FENCE_CLOSE, afterOpen);
  if (end < 0) return null;
  const raw = text.slice(afterOpen, end).trim();
  if (!raw) return null;
  try {
    JSON.parse(raw);
  } catch {
    return null;
  }
  return raw;
}

/** Retire tous les blocs lot du texte narré (affichage). */
export function stripBatchFence(text: string): string {
  let out = text;
  for (;;) {
    const start = out.indexOf(FENCE_OPEN);
    if (start < 0) return out.trim();
    const afterOpen = start + FENCE_OPEN.length;
    const end = out.indexOf(FENCE_CLOSE, afterOpen);
    if (end < 0) return (out.slice(0, start) + out.slice(afterOpen)).trim();
    out = `${out.slice(0, start)}${out.slice(end + FENCE_CLOSE.length)}`;
  }
}
