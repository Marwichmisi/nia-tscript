# Matrice par arch + vernis V1 — ticket #18

Spec : #8 (matrice §8 de `docs/research/packaging-tauri-multiclient.md`).
Harnais : `pcb-mcp/scripts/matrix-v1.mjs` (`bun run matrix` depuis `pcb-mcp/`).
Tests statiques : `pcb-mcp/test/matrix-static.test.ts` (cas 1+2, 7 tests).
Date : 2026-11-02. Hôte : `x86_64-unknown-linux-gnu`, rustc 1.98.1, bun 1.3.11, node v26.13.0.

## 1. Six triples : 1 vert, 5 écarts documentés avec preuve

| Triple | Suffixe fichier | Statut V1 | Preuve / écart |
|---|---|---|---|
| `x86_64-unknown-linux-gnu` (hôte) | `pcb-mcp-x86_64-unknown-linux-gnu` | **vert** | `src-tauri/binaries/` : 126 493 130 octets (~121 Mo), +x ; `tauri.conf.json > bundle.externalBin = ["binaries/pcb-mcp"]` ; boot + readiness + boucle : 12/12 verts (voir §2). |
| `aarch64-unknown-linux-gnu` | `pcb-mcp-aarch64-unknown-linux-gnu` | **écart documenté** | Cross depuis x64 : `rustc --print host-tuple` du runner ≠ cible ; le script `build.mjs` actuel renomme au triple hôte. `bun build --compile` cross-OS exige `--compile-executable-path` + téléchargement du runtime cible (flag prouvé dans `bun build --help` local, binaire non produit ici — pas de téléchargement sur cette carte). À produire sur runner ARM64 (CI `tauri build`). |
| `x86_64-pc-windows-msvc` | `pcb-mcp-x86_64-pc-windows-msvc.exe` | **écart documenté** | `.exe` obligatoire (non produit sur Linux) ; build Bun avec `--windows-hide-console` + métadonnées `--windows-*` (flags constatés dans `--help`, jamais exercés) ; lockfile `%LOCALAPPDATA%\niatscircuit\mcp.json` sans `0600` (ACL profil, cf. §9.6 findings) ; kill via `TerminateProcess`/Job Objects à prouver sur Windows. |
| `aarch64-pc-windows-msvc` | `pcb-mcp-aarch64-pc-windows-msvc.exe` | **écart documenté** | Idem + runner ARM64 requis. |
| `x86_64-apple-darwin` | `pcb-mcp-x86_64-apple-darwin` | **écart documenté** | Signature + `hardenedRuntime` requis en distrib (réf. config Tauri, jamais exercés) ; lockfile `~/Library/Caches/niatscircuit/mcp.json` ; notarisation requise (voir §9 findings). |
| `aarch64-apple-darwin` | `pcb-mcp-aarch64-apple-darwin` | **écart documenté** | Idem Apple Silicon ; `tauri build` réel par OS reste à prouver (§9.1). |

Taille borne basse confirmée : sidecar hôte ≈ 121 Mo (bun 1.3.11 embarque le runtime, cf. findings §3 : hello-world 99 Mo).

## 2. Cas §8 rejoués sur l'hôte (harnais, 12/12 verts)

```
✓ 8.2.1-nommage : host=x86_64-unknown-linux-gnu size=126493130 externalBin=binaries/pcb-mcp
✓ 8.2.2-capabilities : validator=^[0-9]{2,5}$ evil_rejeté=true
✓ 8.2.3-boot : spawn pcb-mcp-x86_64-unknown-linux-gnu :PORT readiness=true
✓ 8.2.3-lockfile : mode=600 pid_vivant=true (single-instance en premier, 2e lancement => focus)
✓ 8.2.4-stale-lock : kill -9 : ready_avant=true probe_après_kill=KO(true) respawn_ready=true token_régénéré=true
✓ 8.2.5-multi-client : 2 clients SDK simultanés => 1 serveur, id_corrélés=true
✓ 8.2.5b-bridges-réels : 2 process bridge.mjs simultanés => 1 serveur, id_corrélés=true
✓ 8.2.6-logs : console.log dans src=0 ; sidecar stdout=0o ; requête invalide -> erreur protocole=true
✓ 8.2.7-port-occupé : clash_ready=false squat_tenu=true repli=PORT ready=true (setup retry 3x)
✓ 8.2.8-latence : n=40 mutantes live_manage.move sous 4 clients p50≈3.5s p95≈11s (file+compile, voir §4)
✓ 8.2.9-dbus : service=org.dev_nia_tscircuit_studio.SingleInstance (manifests ci-dessous)
✓ boucle-agent : observer→éditer→compiler→checks→screenshot→export = 8/8 ok
```

Détail par cas :

1. **Nommage** — `tauri.conf.json` déclare le nom nu, le binaire triple-suffixé existe, Tauri le place au runtime sous le nom nu (ctx7 `copy_binaries` : suffixe retiré au bundle).
2. **Capabilities** — `default.json` : `shell:allow-spawn` verrouillé `["serve","--port",{validator:"^[0-9]{2,5}$"}]`, `allow-stdin-write` + `allow-kill` présents, aucun `"args": true`, aucun `allow-execute` sur `pcb-mcp`. `evil;rm` rejeté par le validator (test `matrix-static.test.ts`). Ordre exact exigé = ordre d'appel Rust (`boot.rs`/`lib.rs`).
3. **Boot** — cold start : `spawn_sidecar(bin, port, token)` + `wait_ready` 10 s (poll `initialize` → `serverInfo`) puis lockfile `0600` APRÈS readiness (simulé en tmpdir dans le harnais : le vrai lockfile est écrit par le `setup()` Tauri, non rejouable hors app). `single-instance` enregistré en premier (`lib.rs`), 2ᵉ lancement ⇒ `set_focus`, pas de 2ᵉ lockfile. Test Rust `sidecar_spawn_probe_and_guards` : GET `/mcp` ⇒ 405, sans bearer ⇒ 401.
4. **Stale-lock** — kill -9 RÉEL d'un sidecar jetable : ready avant ⇒ probe KO après kill ⇒ respawn port+token régénérés (jamais réutilisés). `should_reuse_lock(pid_vivant && probe_ok)` ; matrice Rust `stale_lock_matrix` verte.
5. **Multi-client** — gratuit (serveur stateless 2026-07-28, factory par requête) : 2 clients SDK + 2 process `bridge.mjs` réels simultanés (cas 8.2.5b, au-delà du §8) ⇒ 1 seul serveur, `id` corrélés, file drainée dans l'ordre (§5.3 findings). La file sérialise les écritures, les lectures restent concurrentes.
6. **Logs** — `pcb-mcp/src` : zéro `console.log` (test `server.test.ts` S4 + harnais) ; requête invalide (`requete_invalide_xyz`) ⇒ erreur JSON-RPC protocole, sidecar stdout = 0 octet (tout passe par stderr/HTTP). Bridge : `stdout` = lignes JSON-RPC pures, logs `console.error` préfixés `[bridge]` uniquement (tests `purity.test.mjs`, `e2e.test.mjs` framing en rafale).
7. **Port occupé** — port squatté (dummy `listen`) tenu sans crash : le sidecar clashé ne devient jamais ready (`clash_ready=false`, 984 o sur stderr) ; le repli façon `setup()` (re-pick + boot) devient ready. Conforme `lib.rs` : le retry s'appuie sur le timeout readiness 10 s (3 tentatives), pas sur une sortie rapide.
8. **Latence (mutante)** — voir §4.
9. **Linux snap/flatpak** — voir §3.

## 3. Snap / Flatpak DBus (cas 8.2.9)

Service publié par le plugin (identifier `dev.nia.tscircuit-studio` → underscores) :

```
org.dev_nia_tscircuit_studio.SingleInstance
```

Source : ctx7 `tauri-docs > plugin/single-instance > Usage in Snap and Flatpak`.
`src-tauri` ne contient pas encore de `snapcraft.yaml` / manifeste flatpak (pas de packaging sandbox au MVP) : à déclarer au packaging avec ce nom de service exact.

```yaml
# snapcraft.yaml — extrait à figer au packaging (noms exacts V1)
slots:
  single-instance:
    interface: dbus
    bus: session
    name: org.dev_nia_tscircuit_studio.SingleInstance
plugs:
  single-instance-plug:
    interface: dbus
    bus: session
    name: org.dev_nia_tscircuit_studio.SingleInstance
apps:
  nia-tscircuit-studio:
    plugs: [single-instance-plug]
    slots: [single-instance]
```

```yaml
# flatpak manifest — extrait à figer au packaging
finish-args:
  - --talk-name=org.dev_nia_tscircuit_studio.SingleInstance
  - --own-name=org.dev_nia_tscircuit_studio.SingleInstance
```

Sans ces déclarations, le single-flight est cassé en sandbox (limite honnête, non testée ici).

## 4. Latence file (mutante, §8.2.8)

Mesure harnais : 40 × `tools/call live_manage.move` (écriture mutante via la file sérialisée + recompile) sous 4 clients concurrents contre le sidecar réel. Les latences incluent l'attente de file : c'est le scénario §8.2.8 réel, pas une lecture.

| Run | p50 | p95 |
|---|---|---|
| 2026-11-02 run 1 (mutante) | 3460 ms | 11098 ms |
| 2026-11-02 run 2 (mutante) | 3542 ms | 11843 ms |

Référence lectures seules (`pcb_state`, runs précédents) : p50 ≈ 30 ms, p95 ≈ 60–110 ms. Enseignement V1 (vernis) : une itération mutante coûte ~1 s de compile + attente de file sous contention (file V1 par design, §5.3 findings) ; une boucle agent de 5 mutantes concurrentes peut dépasser 10 s mur. À reconsigner par arch sur runners CI ; piste V2 : compile incrémentale / priorité lectures.

## 5. Boucle complète agent (observer→éditer→compiler→checks→screenshot→export)

Démontrée de bout en bout contre le sidecar réel dans le harnais (`boucle-agent`, 8/8) :

1. `pcb_state` — board `nia-demo`, ready, compile/drc.
2. `logs_read` — curseurs + `newErrors`.
3. `code_patch` (`resistance="10k"` → `"4k7"`) — diagnostics compilateur dans la réponse.
4. `run_checks` domaine `all` — gate placement + violations positionnées.
5. `live_manage` `move R1 → (-4, 3)` — write-through TSX + recompile.
6. `preview_screenshot` `pcb_2d` — lecture du PNG + meta déposés via le même seam fichier que la commande Tauri `save_screenshot` (`preview.rs::write_preview` : `<source>.png` + `<source>.json`, spec §8 : la capture WebView canvas/SVG elle-même est couverte par #15, pas rejouée ici). Retour : base64 + dimensions + `previewUrl` file://.
7. `batch_execute` `[{rotate R1 90°}]` — une seule approbation, rollback testé en `batch*.test.ts`.
8. `fab_export` `nia-matrix` — gerbers + PnP + BOM + `kicad_zip` silencieux + `fab_upload.zip`.

## 6. Limites honnêtes restantes (rejoint §9 findings)

- `tauri build` réel par triple + embarquement `externalBin` (taille bundle finale) : runners CI par OS.
- Cross-compile Bun darwin/windows (téléchargement runtime cible, flags `--windows-*`).
- Updater + signing (certificat Windows, `hardenedRuntime` macOS, notarisation).
- Kill/shutdown Windows (`TerminateProcess`/Job Objects) + suppression lockfile.
- ACL Windows du lockfile (équivalent `0600`).
- Rotation token horaire (par boot seul au MVP) + zéro-stockage serveur.
- Comportement réel des 4 clients sur 2026-07-28 (headers `Mcp-*`, SSE, fallback legacy) face au bridge.
