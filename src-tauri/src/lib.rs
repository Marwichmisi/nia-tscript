mod boot;

use std::net::TcpListener;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::Manager;

#[derive(Debug, Clone, Default, serde::Serialize)]
struct BootState {
    ready: bool,
    port: u16,
    pid: u32,
    url: String,
    protocol_version: String,
}

impl BootState {
    fn from_lock(lock: &boot::McpLock, ready: bool) -> Self {
        Self {
            ready,
            port: lock.port,
            pid: lock.pid,
            url: lock.url.clone(),
            protocol_version: lock.protocol_version.clone(),
        }
    }
}

#[tauri::command]
fn get_boot_state(state: tauri::State<'_, Arc<Mutex<BootState>>>) -> BootState {
    state.lock().expect("boot state").clone()
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
        .on_window_event(|win, event| {
            // §5.2.6 : à la fermeture, suppression best-effort du lockfile
            // (token éphémère jamais réutilisé ; le stale-lock couvre les crashs).
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(cache) = win.app_handle().path().app_cache_dir() {
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
        .invoke_handler(tauri::generate_handler![get_boot_state])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Séquence setup() (§5.2 findings) :
/// 1. single-instance déjà enregistré (refocus si 2e lancement).
/// 2. lockfile existant ? pid vivant + probe OK => s'y attacher.
/// 3. sinon boot frais : listener 127.0.0.1:0 (pas de race) + token éphémère.
/// 4. stub interne (#9 ; spawn sidecar activé en #10) + poll readiness.
/// 5. écriture lockfile 0600 APRÈS readiness. Token jamais loggé.
fn boot_or_attach(app: &tauri::AppHandle) -> Result<BootState, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache_dir indisponible: {e}"))?;
    let lock_path = boot::lockfile_path(&cache_dir);

    // 2. Stale-lock : s'attacher si l'instance propriétaire est joignable.
    if let Ok(existing) = boot::read_lockfile(&lock_path) {
        let alive = boot::is_process_alive(existing.pid);
        let ok = boot::probe_ready(&existing.url, &existing.token);
        if boot::should_reuse_lock(alive, ok) {
            return Ok(BootState::from_lock(&existing, true));
        }
    }

    // 3. Boot frais : bind atomique (le port final = celui du lockfile).
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind 127.0.0.1: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    let token = boot::generate_token();

    // 4. Stub interne (#9). Le spawn sidecar `pcb-mcp serve --port` (capability
    // déjà verrouillée) sera branché ici en #10 quand le binaire existera.
    let ready = Arc::new(AtomicBool::new(false));
    let _server = boot::serve_listener(listener, token.clone(), ready.clone());
    // Boot complet (file V1 rattachée dès #10) => readiness true.
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

    Ok(BootState::from_lock(&lock, true))
}
