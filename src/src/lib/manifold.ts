// Manifold local 0.1.3 (offline-first, sans bundling).
// `CadViewer` charge `manifold-3d@3.5.1` depuis jsdelivr par défaut, ce qui casse
// sous Tauri (CSP, pas de réseau) avec :
// `Failed to initialize Manifold: Importing a module script failed.`
// On sert les fichiers pinnés depuis `public/manifold/` (copiés de
// `manifold-3d@3.5.1`) et on les pose sur `window.ManifoldModule` :
// `load-manifold.ts` du 3d-viewer les réutilise sans import réseau.
// Pas d'import statique : évite l'OOM Vite + `node:module` externalisé.
let pending: Promise<unknown> | null = null;

export function preloadManifold(): Promise<unknown> {
  if (typeof window !== "undefined" && window.ManifoldModule) {
    return Promise.resolve(window.ManifoldModule);
  }
  if (!pending) {
    pending = (async () => {
      const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
      const jsUrl = `${base}manifold/manifold.js`;
      const wasmUrl = `${base}manifold/manifold.wasm`;
      const factory = (
        await import(/* @vite-ignore */ jsUrl)
      ).default as (opts: {
        locateFile: (p: string) => string;
      }) => Promise<{ setup: () => void }>;
      const mod = await factory({
        locateFile: (p: string) =>
          p.endsWith(".wasm") ? wasmUrl : p,
      });
      mod.setup();
      if (typeof window !== "undefined") {
        window.ManifoldModule = mod;
      }
      return mod;
    })().catch((e) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}
