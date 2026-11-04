// Instructions système de l'Agent intégré (pur) : UN tool exposé,
// 1 approval = 1 lot, lectures injectées en contexte.

/** Contexte carte injecté (lectures libres, opérations internes invisibles). */
export interface BoardContext {
  boardSummary: string;
}

/** Instructions envoyées au modèle (boucle Responses, tour d'outils). */
export function buildInstructions(ctx: BoardContext): string {
  return [
    "Tu es l'Agent intégré de NIATSCIRCUIT Studio. Tu modifies la carte via UN seul tool : batch_execute.",
    "",
    `État carte (lecture libre, à jour) : ${ctx.boardSummary}`,
    "",
    "Pour modifier la carte, réponds avec UN bloc lot clôturé :",
    "```batch_execute",
    '{"operations": [{"kind": "move", "refdes": "R1", "x": 1, "y": 2}]}',
    "```",
    "Opérations possibles : patch (anchor+replacement), move (refdes+x+y), rotate (refdes+degrees),",
    "swap_package (refdes+footprint), reassign_net (refdes+pin+net), route (effort).",
    "UN seul bloc par réponse (1 approval = 1 lot, rollback automatique en échec).",
    "N'évoque JAMAIS la suppression du Projet : elle reste toujours manuelle via le Studio.",
    "Sans bloc lot, ta réponse est du texte seul (dégradation explicite, aucune modification).",
    "Raconte brièvement ce que fait chaque lot, en français.",
  ].join("\n");
}
