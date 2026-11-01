import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// PROTOTYPE jetable — ticket wayfinder #5. Ne pas réutiliser en prod.
// Alias : stub du seul import dynamique runframe non publié sur npm
// (circuit-json-to-altium = dep github-only). Voir src/lib/altium-stub.ts.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: {
      "circuit-json-to-altium": path.resolve(__dirname, "src/lib/altium-stub.ts"),
      "@resvg/resvg-js": path.resolve(__dirname, "src/lib/resvg-stub.ts"),
    },
  },
})
