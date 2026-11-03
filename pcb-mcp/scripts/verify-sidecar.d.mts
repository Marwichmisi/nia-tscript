// Déclarations pour ./verify-sidecar.mjs (ticket #40).
// Évite TS7016 dans test/build-repro.test.ts sans activer allowJs.
export declare const MIN_SIDECAR_BYTES: number;
export declare function defaultSidecarPath(): string;
export declare function shouldRefuseWorldWritable(mode: number, platform?: string): boolean;
export declare function verifySidecar(target?: string): {
  path: string;
  size: number;
  worldWritable: false;
};
