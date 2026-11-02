mod boot;
mod preview;

use std::net::TcpListener;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::Manager;

/// Sidecar `pcb-mcp` (#10) : enfant détaché, tué à la fermeture de l'app.
/// `None` = backend stub interne #9 (binaire absent ou spawn KO).
static SIDECAR: OnceLock<Arc<Mutex<Option<std::process::Child>>>> =
    OnceLock::new();

fn sidecar_slot() -> &'static Arc<Mutex<Option<std::process::Child>>> {
    SIDECAR.get_or_init(|| Arc::new(Mutex::new(None)))
}

fn store_sidecar(child: std::process::Child) {
    *sidecar_slot().lock().expect("sidecar slot") = Some(child);
}

fn kill_sidecar() {
    if let Some(mut child) = sidecar_slot().lock().expect("sidecar slot").take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
struct BootState {
    ready: bool,
    port: u16,
    pid: u32,
    url: String,
    protocol_version: String,
    /// Pont MCP embarqué (#26) : chemin absolu résolu au boot, "" si absent.
    /// L'UI l'affiche + le copie ; jamais de token ici.
    bridge_path: String,
}

impl BootState {
    fn from_lock(lock: &boot::McpLock, ready: bool) -> Self {
        Self {
            ready,
            port: lock.port,
            pid: lock.pid,
            url: lock.url.clone(),
            protocol_version: lock.protocol_version.clone(),
            bridge_path: String::new(),
        }
    }

    fn with_bridge_path(mut self, path: String) -> Self {
        self.bridge_path = path;
        self
    }
}

/// Pont MCP embarqué (#26) : candidats prod (`$RESOURCE` bundlé) puis dev
/// (repo via `CARGO_MANIFEST_DIR`), sélection via `boot::find_bridge_in`
/// (duo `bridge.mjs` + `lib.mjs` exigé). Jamais de chemin codé en dur :
/// le layout `$RESOURCE` varie par OS/packaging, le runtime sait.
fn find_bridge(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::path::BaseDirectory;
    let mut out = Vec::new();
    if let Ok(res) = app
        .path()
        .resolve("bridge/bridge.mjs", BaseDirectory::Resource)
    {
        out.push(res);
    }
    out.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bridge/bridge.mjs"),
    );
    boot::find_bridge_in(&out)
}

#[tauri::command]
fn get_boot_state(state: tauri::State<'_, Arc<Mutex<BootState>>>) -> BootState {
    state.lock().expect("boot state").clone()
}

/// Screenshot agent (#15) : la WebView dépose le PNG capturé
/// (canvas/SVG → PNG) dans le dossier partagé avec le sidecar MCP.
/// Jamais d'image inventée côté MCP : sans fichier, `preview_screenshot`
/// répond « ouvre l'app ».
#[tauri::command]
fn save_screenshot(
    _app: tauri::AppHandle,
    source: String,
    data_url: String,
    width: u32,
    height: u32,
) -> Result<preview::SavedPreview, String> {
    let cache = boot::base_cache_dir().ok_or("cache_dir indisponible")?;
    let dir = preview::preview_dir(&cache);
    preview::write_preview(&dir, &source, &data_url, width, height)
}

/// Dossier previews partagé (debug UI).
#[tauri::command]
fn get_preview_dir(_app: tauri::AppHandle) -> Result<String, String> {
    let cache = boot::base_cache_dir().ok_or("cache_dir indisponible")?;
    Ok(preview::preview_dir(&cache).to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let boot_state = Arc::new(Mutex::new(BootState::default()));
    let boot_state_setup = boot_state.clone();
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // single-instance EN PREMIER (findings §4/§5.2) : 2e lancement => refocus.
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _args, _cwd| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            },
        ));
    }
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(boot_state)
        .on_window_event(|_win, event| {
            // §5.2.6 : à la fermeture, tuer le sidecar (#10) puis supprimer
            // le lockfile best-effort (même base que l'écriture : base_cache_dir,
            // cf. bug #25 — app_cache_dir() ajoute l'identifiant et rendait
            // le pont aveugle).
            if matches!(event, tauri::WindowEvent::Destroyed) {
                kill_sidecar();
                if let Some(cache) = boot::base_cache_dir() {
                    let _ = std::fs::remove_file(boot::lockfile_path(&cache));
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = boot_state_setup.clone();
            tauri::async_runtime::spawn(async move {
                match boot_or_attach(&handle) {
                    Ok(info) => {
                        *state.lock().expect("boot state") = info;
                    }
                    Err(e) => {
                        // Jamais de token dans les logs.
                        eprintln!("[boot] échec: {e}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_boot_state,
            save_screenshot,
            get_preview_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Séquence setup() (§5.2 findings) :
/// 1. single-instance déjà enregistré (refocus si 2e lancement).
/// 2. lockfile existant ? pid vivant + probe OK => s'y attacher.
/// 3. sinon boot frais : sidecar `pcb-mcp serve --port` (#10, token via env),
///    retry 3 tentatives avec readiness 10 s chacune.
/// 4. repli stub interne (#9) si binaire absent ou spawn KO répété.
/// 5. écriture lockfile 0600 APRÈS readiness. Token jamais loggé.
fn boot_or_attach(app: &tauri::AppHandle) -> Result<BootState, String> {
    // Pont embarqué (#26) résolu AVANT tout : l'UI + le README en dépendent,
    // mais son absence ne bloque jamais le boot (HTTP directe via lockfile).
    let bridge_path = find_bridge(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if bridge_path.is_empty() {
        eprintln!("[boot] pont MCP embarqué introuvable (repli HTTP directe via lockfile)");
    } else {
        eprintln!("[boot] pont MCP : {bridge_path}");
    }
    // Lockfile au cache de BASE (cf. boot::base_cache_dir) : le pont Node,
    // processus externe, calcule le même chemin. app_cache_dir() ajouterait
    // l'identifiant et rendrait le pont aveugle (bug #25 phase 3).
    // Les previews suivent le même dossier (cohérence WebView ↔ sidecar).
    let cache_dir = boot::base_cache_dir().ok_or("cache_dir indisponible")?;
    let lock_path = boot::lockfile_path(&cache_dir);

    // 2. Stale-lock : s'attacher si l'instance propriétaire est joignable.
    if let Ok(existing) = boot::read_lockfile(&lock_path) {
        let alive = boot::is_process_alive(existing.pid);
        let ok = boot::probe_ready(&existing.url, &existing.token);
        if boot::should_reuse_lock(alive, ok) {
            return Ok(BootState::from_lock(&existing, true).with_bridge_path(bridge_path));
        }
    }

    // 3. Boot frais via sidecar (#10) quand le binaire existe.
    // Binaire présent mais jamais ready après 3 tentatives => erreur dure
    // (pas de lockfile, pas de repli silencieux : un sidecar cassé ne doit
    // pas être masqué). Le repli stub #9 n'a lieu que si le binaire est
    // absent (dev sans `bun build --compile`).
    if let Some(bin) = boot::find_sidecar_bin() {
        let preview_dir = preview::preview_dir(&cache_dir);
        let _ = std::fs::create_dir_all(&preview_dir);
        let mut last_err = String::new();
        for attempt in 1..=3u32 {
            let port = boot::pick_free_port()
                .map_err(|e| format!("port libre indisponible: {e}"))?;
            let token = boot::generate_token();
            match boot::spawn_sidecar(&bin, port, &token, &preview_dir) {
                Ok(child) => {
                    let url = boot::mcp_url(port);
                    if boot::wait_ready(&url, &token, Duration::from_secs(10)) {
                        let lock = boot::build_lock(port, token);
                        boot::write_lockfile(&lock_path, &lock)
                            .map_err(|e| format!("écriture lockfile: {e}"))?;
                        store_sidecar(child);
                        eprintln!(
                            "[boot] sidecar pcb-mcp prêt sur {url} (tentative {attempt})"
                        );
                        return Ok(BootState::from_lock(&lock, true)
                            .with_bridge_path(bridge_path));
                    }
                    last_err = format!("sidecar non ready sur {url}");
                    eprintln!("[boot] {last_err} (tentative {attempt}/3)");
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                }
                Err(e) => {
                    last_err = format!("spawn sidecar KO: {e}");
                    eprintln!("[boot] {last_err} (tentative {attempt}/3)");
                }
            }
        }
        return Err(format!(
            "sidecar pcb-mcp inutilisable après 3 tentatives ({last_err}), pas de lockfile"
        ));
    }
    eprintln!("[boot] binaire pcb-mcp absent, repli stub #9");

    // 4. Stub interne (#9 ; dev sans `bun build --compile`).
    boot_fresh_stub(&lock_path, bridge_path)
}

/// Boot frais sur le stub interne : bind atomique 127.0.0.1:0 (le port final
/// est celui du lockfile, pas de race), token éphémère, readiness pollée
/// jusqu'à 10 s puis lockfile 0600 APRÈS readiness.
fn boot_fresh_stub(lock_path: &std::path::Path, bridge_path: String) -> Result<BootState, String> {
    // Bind atomique (le port final = celui du lockfile).
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind 127.0.0.1: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    let token = boot::generate_token();
    // Stub interne (#9) : écoute minimale, readiness stampée au boot complet.
    let ready = Arc::new(AtomicBool::new(false));
    let _server = boot::serve_listener(listener, token.clone(), ready.clone());
    ready.store(true, Ordering::SeqCst);

    let url = boot::mcp_url(port);
    // §5.2.4 : poll jusqu'à ready (timeout ~10 s) ; échec => pas de lockfile.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut probed = false;
    while std::time::Instant::now() < deadline {
        if boot::probe_ready(&url, &token) {
            probed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !probed {
        return Err("readiness KO après boot (timeout 10 s, pas de lockfile)".into());
    }

    // 5. Lockfile APRÈS readiness.
    let lock = boot::build_lock(port, token);
    boot::write_lockfile(&lock_path, &lock)
        .map_err(|e| format!("écriture lockfile: {e}"))?;

    Ok(BootState::from_lock(&lock, true).with_bridge_path(bridge_path))
}
