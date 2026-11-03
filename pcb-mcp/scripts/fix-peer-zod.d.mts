// Déclarations pour ./fix-peer-zod.mjs (ticket #40). Évite TS7016 sans allowJs.
export declare const PEER_ZOD3_TARGETS: string[];
export declare function findZod3Source(nmDir?: string): string;
export declare function ensurePeerZod3(nmDir?: string): {
  source: string;
  fixed: string[];
};
