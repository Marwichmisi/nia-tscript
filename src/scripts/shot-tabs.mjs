// Vérification visuelle #15 : capture les 3 onglets via Chrome headless.
// Usage : npm run dev (dans src/) puis `node scripts/shot-tabs.mjs`.
// Écrit /tmp/opencode/preview-tabs/{schema,pcb,3d}.png + offline.png.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const outDir = "/tmp/opencode/preview-tabs";
fs.mkdirSync(outDir, { recursive: true });

const tabs = ["schema", "pcb", "3d"];
for (const tab of tabs) {
  const out = `${outDir}/${tab}.png`;
  execFileSync(
    "google-chrome",
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=1280,900",
      "--hide-scrollbars",
      `--screenshot=${out}`,
      `http://localhost:1420/?tab=${tab}`,
    ],
    { stdio: "inherit", timeout: 120000 },
  );
  console.log(`OK ${tab} -> ${out} (${fs.statSync(out).size} octets)`);
}
// Cas offline strict (bandeau explicite attendu).
const outOff = `${outDir}/offline.png`;
execFileSync("google-chrome", [
  "--headless",
  "--disable-gpu",
  "--no-sandbox",
  "--window-size=1280,900",
  "--hide-scrollbars",
  `--screenshot=${outOff}`,
  "http://localhost:1420/?tab=schema",
]);
console.log(`OK offline -> ${outOff}`);
