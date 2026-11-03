// Déclarations pour ./check-types.mjs (revue #37 item 5).
// Évite TS7016 dans test/build-repro.test.ts sans activer allowJs.
export declare function filterFirstPartyErrors(tscOutput: unknown): {
  firstParty: string[];
  thirdParty: number;
};
