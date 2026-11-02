# Spec — pont MCP embarqué dans le bundle Tauri (option C, ticket #26)

Décision amont : [Root README #23](https://github.com/Marwichmisi/nia-tscript/issues/23) —
ni clone git ni npx en chemin principal. L'app installée transporte `bridge/`
et expose son chemin réel ; l'utilisateur colle la commande dans son agent.
Écriture auto dans les configs agents : hors-jeu (cf Out of scope map #20).

Sources : Tauri v2 `develop/resources` (Context7 `/tauri-apps/tauri-docs`,
vérifié 2026-11-02) + précédent interne `sidecar_candidate_paths`
(`src-tauri/src/boot.rs:320-343`).

## 1. Fichiers embarqués

- `bridge/bridge.mjs` (7 Ko) + `bridge/lib.mjs` (5 Ko) — les deux, car
  `bridge.mjs:9-18` importe `./lib.mjs`. Rien d'autre : que des builtins
  `node:` (`fs`, `os`, `path`, `url`), shebang `#!/usr/bin/env node`, Node ≥ 20.
- Poids bundle : ~13 Ko, négligeable vs sidecar `pcb-mcp` (~100 Mo).
- `package.json` / `test/` du pont : NON embarqués (pas nécessaires au runtime).

## 2. Diff `src-tauri/tauri.conf.json`

Ajouter sous `bundle` (forme map : contrôle exact de la destination
`$RESOURCE`, structure préservée) :

```json
"resources": {
  "../bridge/bridge.mjs": "bridge/bridge.mjs",
  "../bridge/lib.mjs": "bridge/lib.mjs"
}
```

Chemins sources relatifs à `src-tauri/`. Cibles relatives à `$RESOURCE`.
Si la forme map est rejetée au build, repli : liste
`["../bridge/bridge.mjs", "../bridge/lib.mjs"]`
(destination `$RESOURCE/_up_/bridge/…`, adapter §3 en conséquence).
Vérification au premier `tauri build` (cf #25).

`externalBin` (`pcb-mcp`), `capabilities`, CSP : inchangés.

## 3. Rust — résolution au boot (miroir du sidecar)

Nouveau helper dans `src-tauri/src/boot.rs`, même pattern que
`sidecar_candidate_paths()` (prod d'abord, dev ensuite) :

```rust
/// Candidats pont MCP : 1) $RESOURCE bundlé (prod installée),
/// 2) repo `bridge/` (dev/test via CARGO_MANIFEST_DIR).
/// Exige le duo bridge.mjs + lib.mjs (sibling check).
pub fn bridge_candidate_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(res) = app.path().resolve("bridge/bridge.mjs", tauri::path::BaseDirectory::Resource) {
        out.push(res);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bridge/bridge.mjs");
    out.push(dev);
    out
}

pub fn find_bridge() -> Option<PathBuf> {
    // + vérifie que lib.mjs existe à côté (même dossier)
}
```

Règles :

- Résolution **uniquement** via `BaseDirectory::Resource` — jamais de chemin
  absolu codé en dur (le layout `$RESOURCE` diffère par OS/packaging :
  `Contents/Resources` macOS, dossier install Linux/Windows ; le runtime sait).
- Au boot (`boot_or_attach`, `lib.rs`) : log une ligne
  `mcp-bridge : <chemin absolu>` (chemin seul, pas de token).
  Si introuvable : `bridge_path = ""` + log warn, le reste du boot continue
  (le MCP reste joignable en HTTP directe via lockfile).
- `BootState` (`lib.rs:33-39`) gagne un champ `bridge_path: String`
  (vide si absent) — la commande `get_boot_state` existante le remonte,
  aucun nouveau round-trip IPC.

Tests Rust à ajouter (même style que `boot.rs` tests) : duo présent/absent,
ordre prod-avant-dev, `bridge_path` vide sans panique.

## 4. Frontend — afficher + copier (pas d'auto-config)

`src/src/App.tsx` (panneau boot actuel `prêt — url (pid)`) :

- Affiche `pont : <bridge_path>` quand non vide, sinon rien (pas d erreur :
  HTTP directe reste le secours documenté).
- Bouton « copier » par agent ? Minimal : un seul bouton copiant la commande
  OpenCode (agent P0 le plus courant), le README liste les 4 variantes.
- Aucune écriture vers `~/.config`, `.mcp.json`, `config.toml` — l'app ne
  touche jamais aux fichiers perso (décision #23 maintenue).

## 5. Template README (consomme #22, applique #23)

`<PONT>` = chemin copié depuis l'app (ex. `/usr/lib/nia-tscircuit-studio/resources/bridge/bridge.mjs`
— exemple indicatif, le vrai chemin vient de l'app, §3) :

```bash
# OpenCode V2
opencode mcp add niatscircuit --global -- node "<PONT>"
# Claude Code
claude mcp add --transport stdio niatscircuit -- node "<PONT>"
```

```toml
# Codex ~/.codex/config.toml
[mcp_servers.niatscircuit]
command = "node"
args = ["<PONT>"]
```

```jsonc
// Cursor .cursor/mcp.json
{ "mcpServers": { "niatscircuit": { "command": "node", "args": ["<PONT>"] } } }
```

+ Section HTTP directe (secours, Bearer du lockfile) et dépannage repris de
  `bridge/README.md`, corrigé V2 (`mcp.servers`, ticket #22).

## 6. Condition de repli npx

`npx -y @nia-tscircuit/mcp-bridge` ne devient une variante documentée que si,
le jour de la release :

1. `npm view @nia-tscircuit/mcp-bridge version` répond, ET
2. le paquet publié contient le même contrat stdio/lockfile que `bridge/`
   (test S1–S5 `npm test` du dossier `bridge/` vert sur le contenu publié).

Sinon la variante npx est retirée des docs (pas de commande qui ment).

## 7. Non-régression (vérifiée en #25)

- `externalBin pcb-mcp` intact, taille bundle +~13 Ko.
- Aucune capability `fs`/`shell` supplémentaire (lecture `$RESOURCE` via
  l'API path, pas de plugin ; Node exécute le pont, pas Tauri).
- `cargo test` (nouveaux tests §3) + `bun test` sidecar inchangés verts.
- #25 prouve sur build installé par OS : app ouverte → `get_boot_state`
  contient `bridge_path` existant, `node <PONT>` + agent connecté.

## 8. Critères d'acceptation de la spec

- [ ] §2 appliqué au premier build sans erreur d'empaquetage (map ou liste).
- [ ] §3 log + `bridge_path` présents en prod ET en `tauri dev`
  (via candidat dev).
- [ ] Le README final (EN + FR, #23) ne contient aucun chemin pont en dur :
  que `<PONT>` + « copier depuis l'app ».
