//! Boot + lockfile single-flight (#9).
//!
//! Helpers purs testés (seams A/B/C sans GUI) :
//! - (A) lockfile `mcp.json` sous `app_cache_dir/niatscircuit/`.
//! - (B) readiness HTTP locale + bearer éphémère.
//! - (C) décision stale-lock / single-flight.
//!
//! Le `setup()` Tauri (voir `lib.rs`) orchestre ces helpers.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

pub const PROTOCOL_VERSION: &str = "2026-07-28";
pub const LOCKFILE_REL: &str = "niatscircuit/mcp.json";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct McpLock {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub url: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    /// Projet ouvert exposé au MCP (Q15) : chemin absolu ou null si Accueil.
    /// `default` garde la compat avec les lockfiles pré-projets.
    #[serde(rename = "projectPath", default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

pub const REGISTRY_REL: &str = "niatscircuit/projects.json";

/// Tire un port libre sur 127.0.0.1 (bind `:0` puis release).
/// Helper testé du seam ; le boot prod lie atomiquement (pas de race),
/// réutilisé tel quel par le spawn sidecar en #10.
#[allow(dead_code)]
pub fn pick_free_port() -> io::Result<u16> {
    let l = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(l.local_addr()?.port())
}

/// Token éphémère : 32 octets aléatoires encodés base64 standard (44 chars).
/// Régénéré à chaque boot, jamais persisté hors lockfile 0600, jamais loggé.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("RNG indisponible pour le token");
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn mcp_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

pub fn lockfile_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(LOCKFILE_REL)
}

/// Dossier cache de BASE (sans identifiant app), même sémantique que
/// `dirs::cache_dir` et que le pont (`bridge/lib.mjs`, `defaultLockfilePath`).
/// Le lockfile `niatscircuit/mcp.json` est lu par un processus externe (le
/// pont Node), donc les deux côtés doivent calculer le même chemin.
/// `app.path().app_cache_dir()` de Tauri ajoute l'identifiant
/// (`dev.nia.tscircuit-studio`) — inutilisable ici : c'était le bug #25
/// (pont aveugle, `-32000` malgré l'app ouverte).
/// Linux : `$XDG_CACHE_HOME` sinon `~/.cache` ; macOS : `~/Library/Caches` ;
/// Windows : `%LOCALAPPDATA%` sinon `~/AppData/Local`.
pub fn base_cache_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join("Library/Caches"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            if !dir.is_empty() {
                return Some(PathBuf::from(dir));
            }
        }
        let home =
            std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        return Some(PathBuf::from(home).join("AppData/Local"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(dir) = std::env::var_os("XDG_CACHE_HOME") {
            if !dir.is_empty() {
                return Some(PathBuf::from(dir));
            }
        }
        let home = std::env::var_os("HOME")?;
        return Some(PathBuf::from(home).join(".cache"));
    }
}

pub fn build_lock(port: u16, token: String) -> McpLock {
    McpLock {
        port,
        url: mcp_url(port),
        token,
        pid: std::process::id(),
        started_at: chrono::Utc::now().to_rfc3339(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        project_path: None,
    }
}

/// Écriture atomique (tmp + rename + fsync fichier + fsync dossier) : un kill
/// en pleine écriture laisse l'ancien contenu intact ou le nouveau complet —
/// jamais un JSON tronqué. Écrivain unique : tout write lockfile/Registre
/// (`write_lockfile`, `project::save_registry_file`) passe par ici.
/// (Miroir de `atomicWriteFileSync` côté sidecar.)
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write as _;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let tmp = path.with_extension(format!(
        "tmp.{}.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    #[cfg(windows)]
    {
        // `rename` Windows refuse d'écraser : suppression préalable (fenêtre
        // de race minimale, le tmp reste isolé en cas de kill).
        let _ = std::fs::remove_file(path);
    }
    let renamed = std::fs::rename(&tmp, path);
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    renamed?;
    if let Some(parent) = path.parent() {
        if let Ok(d) = std::fs::File::open(parent) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Écrit le lockfile (crée les parents), mode 0600 sur Unix.
/// Atomique (cf. `atomic_write`) : kill en pleine écriture → lock intact.
/// Windows : équivalent 0600 via `icacls` (héritage coupé, seul
/// l'utilisateur courant garde R/W) — refus explicite si durcissement KO.
pub fn write_lockfile(path: &Path, lock: &McpLock) -> io::Result<()> {
    let json = serde_json::to_string_pretty(lock)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write(path, json.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        harden_lockfile_windows(path)?;
    }
    Ok(())
}

/// Équivalent 0600 Windows (ticket #42) : coupe l'héritage ACL et n'accorde
/// que l'utilisateur courant (R,W). Échec → erreur (fail-closed : jamais de
/// lockfile lisible par tous).
#[cfg(windows)]
fn harden_lockfile_windows(path: &Path) -> io::Result<()> {
    let user = std::env::var("USERNAME").map_err(|_| {
        io::Error::new(io::ErrorKind::NotFound, "USERNAME introuvable (durcissement lockfile)")
    })?;
    let status = std::process::Command::new("icacls.exe")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("{user}:(R,W)"))
        .status()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("icacls indisponible : {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("icacls a refusé le durcissement ({status})"),
        ))
    }
}

pub fn read_lockfile(path: &Path) -> io::Result<McpLock> {
    let text = std::fs::read_to_string(path)?;
    serde_json::from_str(&text)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Vivacité du pid propriétaire du lock (stale-lock).
#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // kill(pid, 0) ne signale rien, vérifie l'existence.
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(code) if code == libc::ESRCH => false,
        // EPERM (existe, pas de permission) ou autre : conservateur.
        // La probe HTTP arbitre de toute façon (should_reuse exige les deux).
        _ => true,
    }
}

/// MVP non-unix : seul le pid courant est vérifiable sans dépendance.
/// Durcir en #18 (matrice par arch : Toolhelp + ACL). La probe arbitre déjà.
#[cfg(not(unix))]
pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 || pid == u32::MAX {
        return false;
    }
    pid == std::process::id()
}

pub fn extract_bearer(header: Option<&str>) -> Option<String> {
    let h = header?.trim();
    let tok = h.strip_prefix("Bearer ")?.trim();
    if tok.is_empty() {
        return None;
    }
    Some(tok.to_string())
}

pub fn is_authorized(header: Option<&str>, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    match extract_bearer(header) {
        Some(tok) => tok == expected,
        None => false,
    }
}

/// Décision stale-lock : `true` = réutiliser le lock existant (s'y attacher),
/// `false` = régénérer (nouveau port + token).
pub fn should_reuse_lock(pid_alive: bool, probe_ok: bool) -> bool {
    pid_alive && probe_ok
}

pub fn readiness_body(ready: bool) -> String {
    serde_json::json!({"ready": ready, "protocolVersion": PROTOCOL_VERSION}).to_string()
}

// --- Serveur stub interne (#9) + probe -------------------------------------
//
// Socle en attendant le vrai sidecar `pcb-mcp` (#10) : écoute HTTP minimale
// sur 127.0.0.1, Bearer obligatoire, `ready` stampé quand le boot est complet.
// Le endpoint servi (`GET`/`POST /mcp`, rien d'autre) est le contrat que
// #10 devra aussi exposer pour que la probe reste inchangée.

/// Démarre le serveur stub sur un listener déjà bindé (pas de race port).
/// Retourne le thread détaché. `ready` passe à true quand le boot est complet.
pub fn serve_listener(
    listener: TcpListener,
    token: String,
    ready: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => handle_stub_conn(stream, &token, &ready),
                Err(_) => break,
            }
        }
    })
}

fn handle_stub_conn(mut stream: TcpStream, token: &str, ready: &Arc<AtomicBool>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    // Lit jusqu'à fin des headers (ou 8 Ko max).
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= 8192 || find_headers_end(&buf).is_some() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let req = String::from_utf8_lossy(&buf);
    let mut lines = req.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let auth: Option<String> = lines
        .take_while(|l| !l.trim().is_empty())
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("authorization") {
                Some(v.trim().to_string())
            } else {
                None
            }
        });

    let ok_method = method == "GET" || method == "POST";
    let ok_path = path == "/mcp";
    let (status, body) = if !ok_method || !ok_path {
        ("404 Not Found", r#"{"error":"not-found"}"#.to_string())
    } else if !is_authorized(auth.as_deref(), token) {
        ("401 Unauthorized", r#"{"error":"unauthorized"}"#.to_string())
    } else {
        (
            "200 OK",
            readiness_body(ready.load(Ordering::SeqCst)),
        )
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
}

/// Probe de readiness : connect + requête authentifiée.
/// Retourne `true` ssi HTTP 200 ET body exploitable :
/// - stub interne (#9) : body `ready:true` ;
/// - sidecar `pcb-mcp` (#10) : réponse MCP valide (le stub ne connaît pas
///   `tools/list`, le sidecar répond 200 avec la liste des outils).
/// Timeout total ~3,5 s max.
pub fn probe_ready(url: &str, token: &str) -> bool {
    probe_ready_with(url, token, PROBE_INITIALIZE_BODY)
}

/// Variante avec body explicite.
/// Le stub #9 ignore le body ; le sidecar #10 exige un JSON-RPC valide
/// (enveloppe `_meta` moderne ou handshake legacy).
pub fn probe_ready_with(url: &str, token: &str, body: &[u8]) -> bool {
    let (addr, path) = match parse_mcp_url(url) {
        Some(v) => v,
        None => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(1500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return false;
    }
    if stream.write_all(body).is_err() {
        return false;
    }
    let mut resp = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                resp.extend_from_slice(&chunk[..n]);
                if resp.len() > 65536 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&resp);
    let status_ok = text.lines().next().is_some_and(|l| l.contains("200"));
    // Stub #9 : `{"ready":true,…}` ; sidecar #10 : réponse d'`initialize`
    // contenant `serverInfo` (le stub ne produit jamais cette clé, et le
    // body `ready:false` ne doit pas passer pour ready).
    status_ok && (text.contains(r#""ready":true"#) || text.contains(r#""serverInfo""#))
}

/// Body de probe compatible des deux backends : handshake legacy
/// (le stub #9 ignore le body, le sidecar #10 le sert en 200 via
/// le fallback `legacy: 'stateless'`).
pub const PROBE_INITIALIZE_BODY: &[u8] = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"nia-boot-probe","version":"0.1.0"}}}"#;

fn parse_mcp_url(url: &str) -> Option<(SocketAddr, String)> {
    let rest = url.strip_prefix("http://")?;
    let (host_port, path) = rest.split_once('/')?;
    let path = format!("/{path}");
    let (host, port) = host_port.split_once(':')?;
    if host != "127.0.0.1" {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    let ip: std::net::IpAddr = "127.0.0.1".parse().ok()?;
    Some((SocketAddr::new(ip, port), path))
}

// --- Sidecar `pcb-mcp` (#10) -------------------------------------------------
//
// Le binaire est produit par `pcb-mcp/scripts/build.mjs`
// (`bun build --compile`) et déclaré en `externalBin` triple-suffixé.
// En prod (bundlé), Tauri le place à côté de l'exécutable sous le nom nu
// `pcb-mcp` ; en dev/test, il est sous `src-tauri/binaries/pcb-mcp-<triple>`.

/// Candidats binaire sidecar : d'abord le répertoire de l'exécutable courant
/// (prod bundlé : nom nu), puis `src-tauri/binaries/pcb-mcp-*` (dev/test).
pub fn sidecar_candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["pcb-mcp", "pcb-mcp.exe"] {
                out.push(dir.join(name));
            }
        }
    }
    let manifest_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if let Ok(entries) = std::fs::read_dir(&manifest_bin) {
        let mut names: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("pcb-mcp-"))
            })
            .collect();
        names.sort();
        out.extend(names);
    }
    out
}

/// Premier candidat de confiance (cf. `find_trusted_in`), sinon `None`
/// (le boot retombe alors sur le stub interne #9).
pub fn find_sidecar_bin() -> Option<PathBuf> {
    find_trusted_in(&sidecar_candidate_paths())
}

/// Sélection testable (ticket #42) : refuse le stub (trop petit pour servir
/// un MCP) et le binaire world-writable (n'importe quel utilisateur local
/// pourrait le remplacer avant exécution).
pub fn find_trusted_in(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| is_trusted_sidecar_bin(p)).cloned()
}

fn is_trusted_sidecar_bin(path: &Path) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    if !is_real_sidecar_bin(path) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o002 != 0 {
            return false;
        }
    }
    true
}

// --- Pont MCP embarqué (#26) -------------------------------------------------
//
// `bridge.mjs` + `lib.mjs` voyagent dans le bundle (tauri.conf.json >
// bundle > resources, forme map). Le runtime importe `./lib.mjs`, d'où
// l'exigence du duo.

/// Premier candidat contenant `bridge.mjs` ET son sibling `lib.mjs`,
/// sinon `None`. Pur et testé ; la résolution `$RESOURCE` (AppHandle)
/// et le repli dev vivent dans le glue appelant.
pub fn find_bridge_in(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| {
            p.file_name().and_then(|n| n.to_str()) == Some("bridge.mjs")
                && p.is_file()
                && p.parent()
                    .map(|d| d.join("lib.mjs").is_file())
                    .unwrap_or(false)
        })
        .cloned()
}

/// Vrai binaire compilé (`bun build --compile` ≈ 100 Mo) vs stub shell
/// (`scripts/ensure-sidecar-stub.sh`, quelques octets) : heuristique de
/// taille pour les tests (le stub ne sert aucun MCP).
pub fn is_real_sidecar_bin(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() > 1_000_000)
}

/// Spawn détaché : `bin serve --port <port>`, token via env (jamais en argv,
/// jamais loggé), stdout neutralisée, stderr héritée (logs serveur).
/// `preview_dir` partagé WebView ↔ MCP (#15) via `PCB_MCP_PREVIEW_DIR`.
pub fn spawn_sidecar(
    bin: &Path,
    port: u16,
    token: &str,
    preview_dir: &Path,
) -> io::Result<std::process::Child> {
    if port == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "port 0 interdit au sidecar (port explicite requis)",
        ));
    }
    if token.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "token bearer requis",
        ));
    }
    std::process::Command::new(bin)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .env("PCB_MCP_TOKEN", token)
        .env("PCB_MCP_PREVIEW_DIR", preview_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()
}

/// Attente readiness avec deadline (poll `probe_ready` toutes les 100 ms).
pub fn wait_ready(url: &str, token: &str, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if probe_ready(url, token) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    probe_ready(url, token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn free_port_is_bindable() {
        let port = pick_free_port().expect("pick_free_port");
        assert!(port >= 1024, "port {port} doit être non-privilégié");
        let l = TcpListener::bind(("127.0.0.1", port));
        assert!(l.is_ok(), "port {port} doit être bindable juste après pick");
    }

    #[test]
    fn token_is_32_bytes_base64_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b, "deux tokens doivent différer");
        let raw = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &a,
        )
        .expect("token base64 valide");
        assert_eq!(raw.len(), 32, "token = 32 octets aléatoires");
    }

    #[test]
    fn url_shape() {
        assert_eq!(mcp_url(4123), "http://127.0.0.1:4123/mcp");
    }

    #[test]
    fn lockfile_path_under_cache() {
        let p = lockfile_path(Path::new("/tmp/Cache"));
        assert_eq!(p, PathBuf::from("/tmp/Cache/niatscircuit/mcp.json"));
    }

    #[test]
    fn build_lock_schema() {
        let lock = build_lock(5123, "tok".into());
        assert_eq!(lock.port, 5123);
        assert_eq!(lock.pid, std::process::id());
        assert_eq!(lock.url, "http://127.0.0.1:5123/mcp");
        assert_eq!(lock.protocol_version, PROTOCOL_VERSION);
        assert!(!lock.started_at.is_empty());
        // RFC3339 parseable
        chrono::DateTime::parse_from_rfc3339(&lock.started_at)
            .expect("startedAt RFC3339");
        // roundtrip JSON avec les clés exactes du contrat
        let v: serde_json::Value =
            serde_json::to_value(&lock).expect("serializable");
        for k in ["port", "token", "pid", "startedAt", "url", "protocolVersion"] {
            assert!(v.get(k).is_some(), "clé manquante: {k}");
        }
    }

    #[test]
    fn write_then_read_roundtrip_and_0600() {
        let dir = std::env::temp_dir().join(format!(
            "nia-boot-test-{}",
            std::process::id()
        ));
        let path = dir.join("niatscircuit/mcp.json");
        let _ = std::fs::remove_dir_all(&dir);
        let lock = build_lock(pick_free_port().unwrap(), generate_token());
        write_lockfile(&path, &lock).expect("write_lockfile crée les parents");
        let back = read_lockfile(&path).expect("read_lockfile");
        assert_eq!(back, lock);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "lockfile mode 0600, got {mode:o}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lockfile_atomique_crash_tmp_cible_intacte() {
        let dir = std::env::temp_dir().join(format!("nia-boot-crash-{}", std::process::id()));
        let path = dir.join("niatscircuit/mcp.json");
        let _ = std::fs::remove_dir_all(&dir);
        let lock = build_lock(pick_free_port().unwrap(), generate_token());
        write_lockfile(&path, &lock).expect("lock initial");
        // Kill simulé en pleine écriture : tmp abandonné, jamais renommé.
        std::fs::write(path.with_extension("json.999.tmp"), "{tronqué").unwrap();
        assert_eq!(read_lockfile(&path).expect("lock intact"), lock);
        let leftovers: Vec<_> = std::fs::read_dir(dir.join("niatscircuit"))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            // Le tmp simulé est volontaire ; l'écrivain n'en laisse aucun.
            .filter(|n| n.contains(".tmp.") && !n.contains("999"))
            .collect();
        assert!(leftovers.is_empty(), "tmp résiduels : {leftovers:?}");
        write_lockfile(&path, &lock).expect("réécriture atomique");
        assert_eq!(read_lockfile(&path).expect("re-lit"), lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_rejects_invalid() {        let dir = std::env::temp_dir().join(format!(
            "nia-boot-invalid-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("mcp.json");
        std::fs::write(&path, "{ pas du json").unwrap();
        assert!(read_lockfile(&path).is_err());
        std::fs::write(&path, r#"{"port":1}"#).unwrap();
        assert!(read_lockfile(&path).is_err(), "champs manquants rejetés");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn process_liveness() {
        assert!(is_process_alive(std::process::id()));
        assert!(!is_process_alive(u32::MAX), "pid impossible = mort");
    }

    #[test]
    fn bearer_parsing_and_auth() {
        assert_eq!(
            extract_bearer(Some("Bearer abc123")),
            Some("abc123".to_string())
        );
        assert_eq!(extract_bearer(None), None);
        assert_eq!(extract_bearer(Some("Basic abc")), None);
        assert_eq!(extract_bearer(Some("Bearer ")), None);
        assert!(is_authorized(Some("Bearer secret"), "secret"));
        assert!(!is_authorized(Some("Bearer wrong"), "secret"));
        assert!(!is_authorized(None, "secret"));
        assert!(!is_authorized(Some("Bearer secret"), ""));
    }

    #[test]
    fn stale_lock_matrix() {
        // pid vivant + probe OK => réutiliser (pas de 2e spawn)
        assert!(should_reuse_lock(true, true));
        // sinon régénérer
        assert!(!should_reuse_lock(true, false));
        assert!(!should_reuse_lock(false, true));
        assert!(!should_reuse_lock(false, false));
    }

    // --- Pont MCP embarqué (#26) : sélection du candidat ---------------------

    fn write_bridge_pair(dir: &Path, with_lib: bool) -> PathBuf {
        std::fs::create_dir_all(dir).expect("mkdir candidat pont");
        let bridge = dir.join("bridge.mjs");
        std::fs::write(&bridge, "#!/usr/bin/env node\n").expect("write bridge.mjs");
        if with_lib {
            std::fs::write(dir.join("lib.mjs"), "// helpers\n").expect("write lib.mjs");
        }
        bridge
    }

    fn bridge_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "nia-bridge-test-{}-{}",
            std::process::id(),
            name
        ))
    }

    #[test]
    fn bridge_prefers_first_complete_candidate() {
        let base = bridge_tmp("order");
        let _ = std::fs::remove_dir_all(&base);
        let a = base.join("a");
        let b = base.join("b");
        let expect = write_bridge_pair(&a, true);
        write_bridge_pair(&b, true);
        assert_eq!(
            super::find_bridge_in(&[a.join("bridge.mjs"), b.join("bridge.mjs")]),
            Some(expect)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn bridge_skips_candidate_missing_lib_sibling() {
        let base = bridge_tmp("sibling");
        let _ = std::fs::remove_dir_all(&base);
        let a = base.join("a");
        let b = base.join("b");
        write_bridge_pair(&a, false);
        let expect = write_bridge_pair(&b, true);
        assert_eq!(
            super::find_bridge_in(&[a.join("bridge.mjs"), b.join("bridge.mjs")]),
            Some(expect)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn bridge_returns_none_when_absent() {
        let base = bridge_tmp("absent");
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(super::find_bridge_in(&[base.join("bridge.mjs")]), None);
        assert_eq!(super::find_bridge_in(&[]), None);
    }

    #[test]
    fn readiness_body_flags_ready_only_when_complete() {
        let on: serde_json::Value =
            serde_json::from_str(&readiness_body(true)).expect("json");
        let off: serde_json::Value =
            serde_json::from_str(&readiness_body(false)).expect("json");
        assert_eq!(on.get("ready"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(off.get("ready"), Some(&serde_json::Value::Bool(false)));
    }

    #[test]
    fn stub_server_probe_roundtrip() {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("bind stub");
        let port = listener.local_addr().unwrap().port();
        let token = generate_token();
        let ready = Arc::new(AtomicBool::new(false));
        serve_listener(listener, token.clone(), ready.clone());
        let url = mcp_url(port);
        // Pas ready avant la fin du boot.
        assert!(!probe_ready(&url, &token));
        // Mauvais token refusé même après ready.
        ready.store(true, Ordering::SeqCst);
        assert!(probe_ready(&url, &token));
        assert!(!probe_ready(&url, "mauvais-token"));
    }

    #[test]
    fn spawn_rejects_invalid_args() {
        let bin = PathBuf::from("/inexistant/pcb-mcp");
        let dir = std::env::temp_dir();
        assert!(super::spawn_sidecar(&bin, 0, "tok", &dir).is_err());
        assert!(super::spawn_sidecar(&bin, 4123, "", &dir).is_err());
    }

    #[test]
    fn wait_ready_false_on_closed_port() {
        let port = super::pick_free_port().expect("port libre");
        let url = super::mcp_url(port);
        assert!(
            !super::wait_ready(&url, "tok", Duration::from_millis(300)),
            "port fermé => pas ready"
        );
    }

    // --- Ticket #42 : refus sidecar world-writable / stub ---------------

    fn trust_tmp(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("nia-trust-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[cfg(unix)]
    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn sidecar_refuse_stub_et_world_writable() {
        let base = trust_tmp("refus");
        // Stub shell (+x mais minuscule) : refusé partout.
        let stub = base.join("pcb-mcp-stub");
        std::fs::write(&stub, "#!/bin/sh\necho stub\n").unwrap();
        #[cfg(unix)]
        chmod(&stub, 0o755);
        assert_eq!(super::find_trusted_in(&[stub.clone()]), None);
        // Faux binaire (taille réelle) world-writable : refusé sur Unix.
        let big = base.join("pcb-mcp-big");
        std::fs::write(&big, vec![0u8; 1_000_001]).unwrap();
        #[cfg(unix)]
        {
            chmod(&big, 0o777);
            assert_eq!(
                super::find_trusted_in(&[big.clone()]),
                None,
                "world-writable refusé"
            );
            // Mêmes octets, permissions saines : accepté.
            chmod(&big, 0o755);
            assert_eq!(super::find_trusted_in(&[big.clone()]), Some(big.clone()));
            // Ordre : le premier candidat de confiance gagne.
            assert_eq!(
                super::find_trusted_in(&[stub, big]),
                super::find_trusted_in(&[base.join("pcb-mcp-big")])
            );
        }
        // Inexistant : jamais de panique, pas de repli silencieux.
        assert_eq!(super::find_trusted_in(&[base.join("absent")]), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn lockfile_durci_proprietaire_seul_windows() {
        let dir = std::env::temp_dir().join(format!("nia-lock-win-{}", std::process::id()));
        let path = dir.join("niatscircuit/mcp.json");
        let _ = std::fs::remove_dir_all(&dir);
        let lock = super::build_lock(5123, super::generate_token());
        super::write_lockfile(&path, &lock).expect("lockfile durci Windows");
        assert_eq!(super::read_lockfile(&path).expect("re-lit"), lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// E2E sidecar réel (#10) : spawn + readiness + guards HTTP.
    /// Skip si le binaire compilé est absent (clone frais sans `bun build`).
    #[test]
    fn sidecar_spawn_probe_and_guards() {
        let Some(bin) = super::find_sidecar_bin() else {
            eprintln!("skip: aucun binaire sidecar (lancer pcb-mcp/scripts/build.mjs)");
            return;
        };
        if !super::is_real_sidecar_bin(&bin) {
            eprintln!("skip: sidecar stub shell (pas le binaire compilé)");
            return;
        }
        let port = super::pick_free_port().expect("port libre");
        let token = super::generate_token();
        let url = super::mcp_url(port);
        let preview_dir = std::env::temp_dir().join(format!("nia-preview-e2e-{}", std::process::id()));
        let mut child = super::spawn_sidecar(&bin, port, &token, &preview_dir)
            .expect("spawn sidecar");
        let ready = super::wait_ready(&url, &token, Duration::from_secs(15));
        // Nettoyage même en échec (pas d'orphelin dans la suite de tests).
        let kill = |c: &mut std::process::Child| {
            let _ = c.kill();
            let _ = c.wait();
        };
        if !ready {
            kill(&mut child);
            panic!("sidecar non ready en 15 s sur {url}");
        }
        // Distinguisher sidecar vs stub #9 : GET /mcp => 405 côté sidecar.
        let (status, _) = raw_http(&url, "GET", None, &token);
        assert!(
            status.contains("405"),
            "sidecar GET /mcp doit être 405, got: {status}"
        );
        // Sans bearer => 401.
        let (status, _) = raw_http(&url, "POST", None, "mauvais-token");
        assert!(
            status.contains("401"),
            "sidecar sans bearer doit être 401, got: {status}"
        );
        kill(&mut child);
    }

    /// Requête HTTP brute minimale (statut + body) contre une URL `mcp_url`.
    fn raw_http(
        url: &str,
        method: &str,
        body: Option<&[u8]>,
        token: &str,
    ) -> (String, String) {
        use std::io::{Read, Write};
        let rest = url.strip_prefix("http://").expect("http url");
        let (host_port, _) = rest.split_once('/').expect("host/path");
        let mut stream = std::net::TcpStream::connect(host_port)
            .expect("connect sidecar");
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let body = body.unwrap_or(super::PROBE_INITIALIZE_BODY);
        let req = format!(
            "{method} /mcp HTTP/1.1\r\nHost: {host_port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(req.as_bytes()).expect("write head");
        stream.write_all(body).expect("write body");
        let mut resp = Vec::new();
        let mut chunk = [0u8; 2048];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => resp.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
        let text = String::from_utf8_lossy(&resp).into_owned();
        let status = text.lines().next().unwrap_or("").to_string();
        (status, text)
    }
}
