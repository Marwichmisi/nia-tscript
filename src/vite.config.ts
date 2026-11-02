import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend Tauri #15 : viewers séparés (variante B), compile partagée
// worker blob-url bundlé (offline-first). Pas de runframe ici.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "esnext",
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    format: "es",
  },
});
