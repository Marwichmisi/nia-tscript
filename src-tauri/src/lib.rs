mod agent; // T5-agent : routeur local (moitié backend, issue #60)
mod boot;
mod llm;
mod preview;
mod project;
mod watch;

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::Emitter;
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

// --- Watcher main.tsx (ticket #43) ------------------------------------------
// Un seul watch actif : ré-armé à chaque ouverture/création, retiré à la
// fermeture. Le garde `watch::ProjectMainWatch` vit dans un thread dédié
// (drop = arrêt) ; seul un drapeau d'arrêt est partagé ici.
struct ActiveWatch {
    stop: Arc<AtomicBool>,
}

static WATCHER: OnceLock<Mutex<Option<ActiveWatch>>> = OnceLock::new();

fn watcher_slot() -> &'static Mutex<Option<ActiveWatch>> {
    WATCHER.get_or_init(|| Mutex::new(None))
}

/// (Ré-)arme le watch sur le Projet ouvert, ou l'arrête si Accueil.
/// L'ancien watch est stoppé avant d'armer le nouveau (jamais deux watches).
fn rewatch_main(app: &tauri::AppHandle, project: Option<&str>) {
    if let Some(prev) = watcher_slot().lock().expect("watcher").take() {
        prev.stop.store(true, Ordering::SeqCst);
    }
    let Some(dir) = project else { return };
    let dir = PathBuf::from(dir);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        match watch::watch_project_main(&dir, watch::WATCH_DEBOUNCE, move |payload| {
            let _ = handle.emit(watch::MAIN_CHANGED_EVENT, payload);
        }) {
            Ok(_watch) => {
                // Garde vivant tant que le Projet est ouvert ; stop → drop.
                while !flag.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            Err(e) => eprintln!("[watch] {e}"),
        }
    });
    *watcher_slot().lock().expect("watcher") = Some(ActiveWatch { stop });
}

/// Ré-arme le watcher d'après le Projet courant (à appeler après chaque
/// changement de `BootState.project_path`).
fn rewatch_current(app: &tauri::AppHandle, state: &tauri::State<'_, Arc<Mutex<BootState>>>) {
    let project = state.lock().expect("boot state").project_path.clone();
    rewatch_main(app, project.as_deref());
}

// --- Sync Projet ouvert via disque (ticket #57, spec #55) -------------------
// T3-sync : le disque (`mcp.json` + Registre) est la source unique, le
// `BootState` un simple miroir. Le sidecar n'a aucun canal vers le backend
// (ADR-0003) : un thread dédié poll le disque toutes les 1-2 s (pas de
// busy-loop) et applique `decide_open_sync` (Confinement + orphelins).
struct OpenSync {
    stop: Arc<AtomicBool>,
}

static OPEN_SYNC: OnceLock<Mutex<Option<OpenSync>>> = OnceLock::new();

fn open_sync_slot() -> &'static Mutex<Option<OpenSync>> {
    OPEN_SYNC.get_or_init(|| Mutex::new(None))
}

/// Intervalle du poll disque : 1-2 s en thread dédié (spec #55).
const OPEN_SYNC_POLL: Duration = Duration::from_millis(1500);

/// Lit le Projet disque (`mcp.json:projectPath`, best-effort) : `None` si
/// lock absent/illisible/sans projet (garde prod : lock absent = Accueil ;
/// le MCP ne crée jamais de lockfile, il ne fait que le patcher).
fn read_disk_project(cache_dir: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(boot::lockfile_path(cache_dir)).ok()?;
    let data: serde_json::Value = serde_json::from_str(&text).ok()?;
    data.get("projectPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Démarre la sync disque → miroir (un seul poll actif ; l'ancien est
/// stoppé). Au changement canonique : `set_current` + rewatch + émission
/// du nouvel event `project-open-changed` (distinct de
/// `project-main-changed`). Hors Registre → refusé (on reste, sans log
/// à chaque tour) ; orphelin/fermeture → Accueil, Registre conservé.
fn start_open_sync(app: &tauri::AppHandle) {
    if let Some(prev) = open_sync_slot().lock().expect("open sync").take() {
        prev.stop.store(true, Ordering::SeqCst);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            std::thread::sleep(OPEN_SYNC_POLL);
            if flag.load(Ordering::SeqCst) {
                break;
            }
            let Some(cache) = boot::base_cache_dir() else {
                continue;
            };
            let reg = project::load_registry_file(&cache);
            let disk = read_disk_project(&cache);
            match project::decide_open_sync(disk.as_deref(), &reg) {
                // T3-sync : hors Registre → Confinement refusé, on reste.
                project::OpenSyncDecision::Keep => {}
                project::OpenSyncDecision::Set(next) => {
                    let state = handle.state::<Arc<Mutex<BootState>>>();
                    let cur = state.lock().expect("boot state").project_path.clone();
                    if next != cur {
                        if next.is_some() {
                            eprintln!("[sync] projet ouvert via disque");
                        } else {
                            eprintln!("[sync] retour Accueil via disque");
                        }
                        set_current_state(&state, next.clone());
                        rewatch_main(&handle, next.as_deref());
                        let _ = handle.emit(
                            watch::OPEN_CHANGED_EVENT,
                            watch::open_changed_payload(next.as_deref()),
                        );
                    }
                }
            }
        }
    });
    *open_sync_slot().lock().expect("open sync") = Some(OpenSync { stop });
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub(crate) struct BootState {
    ready: bool,
    port: u16,
    pid: u32,
    url: String,
    protocol_version: String,
    /// Pont MCP embarqué (#26) : chemin absolu résolu au boot, "" si absent.
    /// L'UI l'affiche + le copie ; jamais de token ici.
    bridge_path: String,
    /// Projet ouvert (Q8/Q15) : chemin absolu ou null si Accueil.
    #[serde(rename = "projectPath")]
    pub(crate) project_path: Option<String>,
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
            project_path: lock.project_path.clone(),
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
/// Avec Projet ouvert : `<projet>/previews/`, sinon cache global.
/// Jamais d'image inventée côté MCP : sans fichier, `preview_screenshot`
/// répond « ouvre l'app ».
/// Jail Confinement (#42) : le Projet ouvert doit être membre du Registre.
#[tauri::command]
fn save_screenshot(
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
    source: String,
    data_url: String,
    width: u32,
    height: u32,
    name: Option<String>,
) -> Result<preview::SavedPreview, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    let dir = match project {
        Some(p) => {
            let reg = load_registry();
            let confined = project::assert_project_member(&p, &reg)?;
            project::project_paths(&confined).previews
        }
        None => {
            let cache = boot::base_cache_dir().ok_or("cache_dir indisponible")?;
            preview::preview_dir(&cache)
        }
    };
    preview::write_preview(&dir, &source, &data_url, width, height, name.as_deref())
}

/// Dossier previews partagé (debug UI) : projet ouvert ou cache global.
/// Jail Confinement (#42) : comme `save_screenshot`.
#[tauri::command]
fn get_preview_dir(
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
) -> Result<String, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    match project {
        Some(p) => {
            let reg = load_registry();
            let confined = project::assert_project_member(&p, &reg)?;
            Ok(project::project_paths(&confined)
                .previews
                .to_string_lossy()
                .to_string())
        }
        None => {
            let cache = boot::base_cache_dir().ok_or("cache_dir indisponible")?;
            Ok(preview::preview_dir(&cache).to_string_lossy().to_string())
        }
    }
}

// --- Projets (Accueil + MCP scopé, Q1-Q16) ----------------------------------
// Registre partagé Rust ↔ sidecar : `base_cache/niatscircuit/projects.json`
// (même raison que le lockfile bug #25 : le sidecar Node calcule le même
// chemin sans AppHandle). Le Projet ouvert vit dans le lockfile
// `projectPath` + `BootState.project_path`.

fn load_registry() -> project::Registry {
    let Ok(cache) = boot::base_cache_dir().ok_or("cache_dir indisponible") else {
        return project::Registry::default();
    };
    project::load_registry_file(&cache)
}

fn save_registry(reg: &project::Registry) -> Result<(), String> {
    let cache = boot::base_cache_dir().ok_or("cache_dir indisponible")?;
    project::save_registry_file(&cache, reg)
}

fn write_lock_project(project: Option<&str>) {
    let Some(cache) = boot::base_cache_dir() else {
        return;
    };
    project::write_lock_project(&cache, project);
}

fn set_current_state(state: &Arc<Mutex<BootState>>, project: Option<String>) {
    state.lock().expect("boot state").project_path = project.clone();
    write_lock_project(project.as_deref());
}

fn set_current(state: &tauri::State<'_, Arc<Mutex<BootState>>>, project: Option<String>) {
    set_current_state(state, project);
}

#[derive(Debug, Clone, serde::Serialize)]
struct ProjectItem {
    path: String,
    name: String,
    /// Dossier parent complet (homonymes distingués dans l'Accueil).
    parent: String,
    exists: bool,
    #[serde(rename = "lastOpened")]
    last_opened: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct ProjectList {
    projects: Vec<ProjectItem>,
    #[serde(rename = "lastOpened")]
    last_opened: Option<String>,
}

#[tauri::command]
fn list_projects() -> Result<ProjectList, String> {
    let mut reg = load_registry();
    // Réconciliation boot (ticket #38) : existence vérifiée, orphelin
    // explicite (`exists: false`), `lastOpened` réparé et persisté.
    let reconciled = project::reconcile_registry(&mut reg);
    if reconciled.current_reset {
        save_registry(&reg)?;
    }
    let mut items: Vec<ProjectItem> = reg
        .projects
        .iter()
        .map(|e| {
            let p = std::path::Path::new(&e.path);
            ProjectItem {
                path: e.path.clone(),
                name: p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&e.path)
                    .to_string(),
                parent: project::parent_of_project_path(&e.path),
                exists: p.exists(),
                last_opened: e.last_opened.clone(),
            }
        })
        .collect();
    // Tri lastOpened desc déjà garanti par upsert, re-tri défensif.
    items.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    Ok(ProjectList {
        projects: items,
        last_opened: reg.last_opened,
    })
}

#[tauri::command]
fn current_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
) -> Result<Option<String>, String> {
    let cur = state.lock().expect("boot state").project_path.clone();
    match cur {
        // Dossier supprimé (orphelin) → Accueil : réinitialisé, pas fantôme.
        Some(p) if !std::path::Path::new(&p).exists() => {
            set_current(&state, None);
            rewatch_main(&app, None);
            Ok(None)
        }
        other => Ok(other),
    }
}

#[tauri::command]
fn create_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
    path: String,
    template: Option<String>,
) -> Result<String, String> {
    let dir = project::canonical_project_path(&path)?;
    let tpl = template.as_deref().unwrap_or("vide");
    project::ensure_project_layout(&dir, tpl)?;
    let mut reg = load_registry();
    project::upsert_registry(&mut reg, &dir.to_string_lossy(), &project::now_rfc3339());
    save_registry(&reg)?;
    let s = dir.to_string_lossy().to_string();
    set_current(&state, Some(s.clone()));
    rewatch_current(&app, &state);
    Ok(s)
}

#[tauri::command]
fn open_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
    path: String,
) -> Result<String, String> {
    let dir = project::canonical_project_path(&path)?;
    if !dir.exists() {
        return Err("dossier introuvable".into());
    }
    let main = project::project_paths(&dir).main;
    if !main.exists() {
        return Err("dossier sans main.tsx : refuse d'ouvrir".into());
    }
    // Disque source de vérité : circuit.json recréé si absent, migré si
    // legacy, erreur visible si corrompu (ticket #38).
    project::ensure_circuit_file(&dir)?;
    let mut reg = load_registry();
    project::upsert_registry(&mut reg, &dir.to_string_lossy(), &project::now_rfc3339());
    save_registry(&reg)?;
    let s = dir.to_string_lossy().to_string();
    set_current(&state, Some(s.clone()));
    rewatch_current(&app, &state);
    Ok(s)
}

#[tauri::command]
fn close_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
) -> Result<(), String> {
    set_current(&state, None);
    rewatch_current(&app, &state);
    Ok(())
}

#[tauri::command]
fn forget_project(path: String) -> Result<(), String> {
    let Some(cache) = boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    // L'oubli ne touche jamais au disque (pas de corbeille en V1) :
    // retrait Registre seul (cf. `project::forget_project_in`).
    project::forget_project_in(&cache, &path)?;
    Ok(())
}

/// Émet un jeton de suppression à usage unique (garde backend #42).
/// Le dialogue natif seul ne suffit plus : `delete_project` exige ce jeton.
/// Hors périmètre → refusé, aucun jeton émis.
#[tauri::command]
fn request_delete_token(path: String) -> Result<String, String> {
    let reg = load_registry();
    project::request_delete_token(&reg, &path)
}

/// Relink un Projet orphelin (ticket #38) : remplace l'ancien chemin par le
/// nouveau (existant + `main.tsx` requis, circuit garanti) en conservant
/// l'ordre et `lastOpened`. Le Projet courant suit s'il était l'orphelin.
#[tauri::command]
fn relink_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    let old = project::canonical_project_path(&old_path)?;
    let new = project::canonical_project_path(&new_path)?;
    if !new.exists() {
        return Err("nouveau dossier introuvable".into());
    }
    if !project::project_paths(&new).main.exists() {
        return Err("nouveau dossier sans main.tsx : refuse de relier".into());
    }
    project::ensure_circuit_file(&new)?;
    let old_s = old.to_string_lossy().to_string();
    let new_s = new.to_string_lossy().to_string();
    let mut reg = load_registry();
    if !reg.projects.iter().any(|e| e.path == old_s) {
        return Err("ancien chemin inconnu du Registre".into());
    }
    for e in reg.projects.iter_mut() {
        if e.path == old_s {
            e.path = new_s.clone();
            e.last_opened = project::now_rfc3339();
        }
    }
    reg.projects
        .sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    if reg.last_opened.as_deref() == Some(old_s.as_str()) {
        reg.last_opened = Some(new_s.clone());
    }
    save_registry(&reg)?;
    let cur = state.lock().expect("boot state").project_path.clone();
    if cur.as_deref() == Some(old_s.as_str()) {
        set_current(&state, Some(new_s.clone()));
    }
    rewatch_current(&app, &state);
    Ok(new_s)
}

#[tauri::command]
fn delete_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
    path: String,
    token: Option<String>,
) -> Result<(), String> {
    // Garde backend (#42) : appartenance + jeton usage unique. Le dialogue
    // natif (frontend) seul ne suffit plus ; sans jeton, refus explicite.
    let Some(t) = token else {
        return Err(
            "confirmation backend requise (jeton manquant) : demandez request_delete_token avant toute suppression"
                .into(),
        );
    };
    let Some(cache) = boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    let key = project::delete_project_in(&cache, &path, &t)?;
    let cur = state.lock().expect("boot state").project_path.clone();
    if cur.as_deref() == Some(key.as_str()) {
        set_current(&state, None);
    }
    rewatch_current(&app, &state);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
struct ProjectMain {
    path: String,
    code: String,
    hash: String,
}

#[tauri::command]
fn read_project_main(
    state: tauri::State<'_, Arc<Mutex<BootState>>>,
    path: Option<String>,
) -> Result<ProjectMain, String> {
    let target = match path {
        Some(p) => project::canonical_project_path(&p)?.to_string_lossy().to_string(),
        None => state
            .lock()
            .expect("boot state")
            .project_path
            .clone()
            .ok_or("aucun projet ouvert")?,
    };
    // Jail Confinement (#42) : lecture refusée hors Registre.
    let reg = load_registry();
    let dir = project::assert_project_member(&target, &reg)?;
    let data = project::read_main_file(&dir)?;
    Ok(ProjectMain {
        path: data.path,
        code: data.code,
        hash: data.hash,
    })
}

#[tauri::command]
fn write_project_main(path: String, code: String) -> Result<ProjectMain, String> {
    // Ticket #45 (coller du TSX, gabarit démo) : écriture frontend autrement
    // impossible (l'agent écrit via MCP). Même jail que la lecture
    // (Confinement #42), écriture atomique + hash relu (#38 source de vérité).
    // Le watcher (#43) émet `project-main-changed` sur le fichier modifié :
    // la WebView resynchronise sans relecture forcée.
    let reg = load_registry();
    let dir = project::assert_project_member(&path, &reg)?;
    let data = project::write_main_file(&dir, &code)?;
    Ok(ProjectMain {
        path: data.path,
        code: data.code,
        hash: data.hash,
    })
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
        .plugin(tauri_plugin_dialog::init())
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
                // Pont résolu ici aussi pour le cas échec : l'UI affiche
                // toujours Copier même si le sidecar est KO.
                let fallback_bridge = find_bridge(&handle)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                match boot_or_attach(&handle) {
                    Ok(info) => {
                        // PAS de reprise du Registre au boot : sans lockfile
                        // (fermeture normale le supprime, le MCP n'en crée
                        // jamais), l'app démarre sur l'Accueil et c'est
                        // l'utilisateur qui ouvre son Projet. Un lockfile
                        // survivant (crash) rouvre le Projet — voulu.
                        // Le MCP `open` app fermée n'écrit que le Registre :
                        // visible dans l'Accueil, à ouvrir à la main.
                        // Watcher temps réel (ticket #43) : armé sur le Projet
                        // rouvert au boot, retiré si Accueil.
                        rewatch_main(&handle, info.project_path.as_deref());
                        // T3-sync : poll disque 1-2 s (miroir suit le MCP).
                        start_open_sync(&handle);
                        *state.lock().expect("boot state") = info;
                    }
                    Err(e) => {
                        // Jamais de token dans les logs.
                        eprintln!("[boot] échec: {e}");
                        state.lock().expect("boot state").bridge_path = fallback_bridge;
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_boot_state,
            save_screenshot,
            get_preview_dir,
            list_projects,
            current_project,
            create_project,
            open_project,
            close_project,
            forget_project,
            relink_project,
            request_delete_token,
            delete_project,
            read_project_main,
            write_project_main,
            // T5-agent (issue #60) : commandes fines du routeur local — seule
            // surface IPC du chemin interne (aucun HTTP/Bearer, jamais de
            // secret vers le frontend).
            agent::agent_fetch,
            agent::agent_commit_files,
            agent::agent_fab_write,
            agent::agent_preview_read,
            // T4 BYOK (ticket #58) : surface IPC LLM — seule autorisée à
            // appeler le fournisseur (cœur testé dans `llm.rs`, jamais de
            // clé vers le frontend, CSP `connect-src` inchangée).
            llm::llm_status,
            llm::llm_verify_and_save,
            llm::llm_test,
            llm::llm_models,
            llm::llm_clear,
            llm::llm_set_telemetry,
            llm::llm_complete
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
