// File de commandes sérialisée (mono-board) — ticket #14.
// Toutes les écritures (live_manage + code_patch) passent par `enqueue`
// pour que deux mutations concurrentes soient drainées dans l'ordre
// d'arrivée, état final cohérent. Lecture seule hors file.
let tail: Promise<void> = Promise.resolve();

/** Sérialise `fn` après les écritures en cours. */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Remet la file à vide (isolation des tests). */
export function resetQueueForTests(): void {
  tail = Promise.resolve();
}
