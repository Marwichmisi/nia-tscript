//! Routeur local T5 — moitié backend (issue #60, spec #55, décision #48 C).
//!
//! L'orchestration vit dans `src/src/lib/agent.ts` (WebView) qui appelle le
//! CŒUR `tools-core` directement ; ce module ne fournit que les EFFETS que
//! la WebView ne peut pas faire elle-même (tout `invoke`, jamais de HTTP
//! direct côté frontend) :
//! - `agent_fetch` : proxy HTTP allowlisté (sourcing JLCPCB-first) ;
//! - `agent_commit_files` : persistance atomique `main.tsx` + `circuit.json` ;
//! - `agent_fab_write` : écriture atomique des artefacts fab ;
//! - `agent_preview_read` : lecture capture (même résolution que le sidecar).
//!
//! Règles d'or : aucun Bearer/token/HTTP dans ce chemin (le frontend ne voit
//! aucun secret) ; Confinement sur chaque appel ; atomicité (tmp+rename) ;
//! une mutation à la fois (verrou global, même discipline que `enqueue`) ;
//! AUCUN canal vers le sidecar (le routeur vit DANS le processus Tauri).
//! Les refus métier (source inconnue, screenshot absent…) sont des sorties
//! `Ok` VERBATIM du sidecar, pas des erreurs.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Proxy sourcing : même source que `tsci search --jlcpcb`
/// (`JLCSEARCH_BASE` côté cœur). Tout le reste est refusé.
pub const JLCSEARCH_PREFIX: &str = "https://jlcsearch.tscircuit.com/";
/// Timeout sourcing (< 15 s, spec #55) : au-delà, refus explicite offline.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// Code garde projet (préfixe messages, convention `llm.rs`).
pub const NO_PROJECT_OPEN: &str = "NO_PROJECT_OPEN";

/// Verrou d'écriture global (file disciplinaire) : une mutation à la fois,
/// même discipline que `enqueue` côté MCP. Les lectures ne le prennent pas.
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Garde G3 : aucun effet backend sans Projet ouvert (le périmètre réseau
/// suit le périmètre disque, cf. ADR 0001 + `llm.rs`).
pub fn require_open_project(project: Option<&str>, tool: &str) -> Result<String, String> {
    match project {
        Some(p) if !p.trim().is_empty() => Ok(p.to_string()),
        _ => Err(format!(
            "{NO_PROJECT_OPEN} : aucun projet ouvert : ouvre un projet dans l'app ou via project_open ({tool})"
        )),
    }
}

/// Allowlist deny-prioritaire du proxy sourcing : seul l'hôte JLCPCB-first
/// du cœur est appelable. Refuse le reste (dont les leurres
/// `…tscircuit.com.evil…` : le préfixe exige le `/` après l'hôte).
pub fn is_fetch_allowed(url: &str) -> bool {
    url.starts_with(JLCSEARCH_PREFIX) && url.len() > JLCSEARCH_PREFIX.len()
}

// --- Export dir (miroir `projectExportDir` + `sanitizeSegment` sidecar) ----
// Règle : `<projet>/exports/<basename>-<hash12>` (homonymes distingués par
// le sha256 du canonique). Miroir documenté : nommage hôte, pas de logique.

/// Segment de chemin sûr (miroir `sanitizeSegment` : `a-z0-9-_`, sinon `-`).
pub fn sanitize_export_segment(s: &str) -> String {
    let t: String = s
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let t = t.trim_matches('-').to_string();
    if t.is_empty() {
        "default".to_string()
    } else {
        t
    }
}

/// Nom projet pour les fichiers KiCad : le routeur le calcule via
/// `exportFab` (sanitisation `default`→`board` du cœur) et l'envoie dans les
/// noms de fichiers ; le backend ne renomme jamais silencieusement.
#[allow(dead_code)]
pub fn export_project_name(basename: &str) -> String {
    let t = sanitize_export_segment(basename);
    if t == "default" {
        "board".to_string()
    } else {
        t
    }
}

/// sha256 hex tronqué à 12 (clé d'homonymes, miroir `hashCanonicalPath`).
pub fn sha256_hex12(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())[..12].to_string()
}

/// Dossier d'export prod (le `sessionId` n'y figure qu'avec l'override de
/// tests côté sidecar, jamais en prod) : `<projet>/exports/<base>-<hash12>`.
pub fn export_dir_for(canonical_project: &Path) -> PathBuf {
    let canon = canonical_project.to_string_lossy().into_owned();
    let base = canonical_project
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let mut safe = sanitize_export_segment(base);
    if safe == "default" {
        safe = "board".to_string();
    }
    canonical_project
        .join(crate::project::EXPORTS_DIR)
        .join(format!("{safe}-{}", sha256_hex12(&canon)))
}

/// `file://` absolue (miroir `pathToFileURL().href` : encodage des segments).
pub fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy();
    let mut segs = Vec::new();
    for seg in s.split('/') {
        let mut enc = String::new();
        for b in seg.as_bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                enc.push(*b as char);
            } else {
                enc.push_str(&format!("%{b:02X}"));
            }
        }
        segs.push(enc);
    }
    format!("file://{}", segs.join("/"))
}

// --- Commit atomique (miroir `persistProjectFiles`) -------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct CommitResult {
    pub path: String,
    pub code_hash: String,
    pub circuit_ok: bool,
}

/// Cœur testable d'`agent_commit_files` : Confinement, verrou d'écriture,
/// `main.tsx` puis `circuit.json` versionné, relecture. Le `circuit_json`
/// est le TABLEAU (l'enveloppe `{version,ciruitJson}` est construite ici).
pub fn commit_files_core(
    cache_dir: &Path,
    project_path: &str,
    code: &str,
    circuit_json: &[serde_json::Value],
) -> Result<CommitResult, String> {
    let reg = crate::project::load_registry_file(cache_dir);
    let dir = crate::project::assert_project_member(project_path, &reg)?;
    let _guard = write_lock().lock().expect("verrou écriture agent");
    let main = crate::project::write_main_file(&dir, code)?;
    let text = crate::project::serialize_circuit(circuit_json)?;
    let circuit = crate::project::project_paths(&dir).circuit;
    crate::boot::atomic_write(&circuit, text.as_bytes())
        .map_err(|e| format!("écriture circuit.json : {e}"))?;
    // Relecture disque (source de vérité) : corrompu = erreur visible.
    let _ = crate::project::read_circuit_file(&dir)?;
    Ok(CommitResult {
        path: main.path,
        code_hash: main.hash,
        circuit_ok: true,
    })
}

// --- Écriture fab ------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FabFileIn {
    /// Chemin relatif sous l'export dir (`gerbers/…`, `bom.csv`, …).
    /// Refuse `..` et l'absolu (Confinement).
    pub name: String,
    /// Contenu encodé base64 (texte UTF-8 ou zip).
    pub base64: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FabArtifactOut {
    pub name: String,
    pub bytes: u64,
    pub preview_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FabWriteResult {
    pub export_dir: String,
    pub artifacts: Vec<FabArtifactOut>,
}

/// Cœur testable d'`agent_fab_write` : Confinement, règle du dossier
/// d'export, écritures atomiques fichier par fichier (même comportement que
/// le sidecar : pas de rollback inter-fichiers, chaque fichier est complet).
pub fn fab_write_core(
    cache_dir: &Path,
    project_path: &str,
    files: &[FabFileIn],
) -> Result<FabWriteResult, String> {
    let reg = crate::project::load_registry_file(cache_dir);
    let dir = crate::project::assert_project_member(project_path, &reg)?;
    for f in files {
        if f.name.trim().is_empty()
            || f.name.starts_with('/')
            || Path::new(&f.name).components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::RootDir
                )
            })
        {
            return Err(format!(
                "nom d'artefact refusé (Confinement) : {}",
                f.name
            ));
        }
    }
    let export_dir = export_dir_for(&dir);
    let _guard = write_lock().lock().expect("verrou écriture agent");
    std::fs::create_dir_all(export_dir.join("gerbers"))
        .map_err(|e| format!("création dossier export : {e}"))?;
    let mut artifacts = Vec::with_capacity(files.len());
    for f in files {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(f.base64.trim())
            .map_err(|e| format!("artefact {} base64 illisible : {e}", f.name))?;
        let full = export_dir.join(&f.name);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("création dossier export : {e}"))?;
        }
        crate::boot::atomic_write(&full, &bytes)
            .map_err(|e| format!("écriture artefact {} : {e}", f.name))?;
        artifacts.push(FabArtifactOut {
            name: f.name.clone(),
            bytes: bytes.len() as u64,
            preview_url: file_url(&full),
        });
    }
    Ok(FabWriteResult {
        export_dir: export_dir.to_string_lossy().into_owned(),
        artifacts,
    })
}

// --- Lecture preview (miroir `readPreview` sidecar, VERBATIM) ---------------

pub const PREVIEW_OFFLINE_BANNER: &str =
    "RÉSEAU REQUIS hors-ligne — CDN désactivé (disableCdnLoading) : preview figée sur la dernière compile locale, aucun circuit-json inventé.";
pub const PREVIEW_NO_GPU_FALLBACK: &str =
    "Sans GPU (WebGPU rendering failed constaté au prototype) : screenshot pcb_2d/pcb_3d bascule sur fallback SVG/canvas 2D documenté, jamais d'image inventée.";

#[derive(Debug, Clone, serde::Serialize)]
pub struct PreviewReadOut {
    pub found: bool,
    pub source: String,
    pub name: Option<String>,
    pub data_url: Option<String>,
    pub bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub preview_url: Option<String>,
    pub updated_at: Option<String>,
    pub banner: Option<String>,
    pub message: Option<String>,
    pub errors: u32,
    pub warnings: u32,
}

fn tab_name(source: &str) -> &'static str {
    match source {
        "schematic_2d" => "Schéma",
        "pcb_2d" => "PCB",
        _ => "3D",
    }
}

/// Plus récent `<source>[__<nom>].png` du dossier (miroir
/// `latestPreviewPath` : mtime max, nom extrait par regex).
fn latest_preview_in(dir: &Path, source: &str) -> Option<(PathBuf, Option<String>)> {
    let entries = std::fs::read_dir(dir).ok()?;
    let plain = format!("{source}.png");
    let prefix = format!("{source}__");
    let mut best: Option<(PathBuf, Option<String>, std::time::SystemTime)> = None;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let slug: Option<String> = if name == plain {
            None
        } else if name.starts_with(&prefix) && name.ends_with(".png") {
            let inner = &name[prefix.len()..name.len() - 4];
            if inner.is_empty()
                || !inner
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                continue;
            }
            Some(inner.to_string())
        } else {
            continue;
        };
        let mtime = e.metadata().and_then(|m| m.modified()).ok()?;
        let is_better = best.as_ref().is_none_or(|b| mtime > b.2);
        if is_better {
            best = Some((e.path(), slug, mtime));
        }
    }
    best.map(|(p, n, _)| (p, n))
}

/// Dimensions PNG (IHDR) : repli quand la méta `.json` est absente (dépôt
/// manuel), miroir `parsePngDimensions`.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 {
        return None;
    }
    if &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// Cœur testable d'`agent_preview_read`. `project` = Projet ouvert (résolu
/// par l'appelant depuis `BootState`) : `None` → `NO_PROJECT_OPEN`, hors
/// Registre → Confinement refusé. Sans repli cache global (comme le cœur :
/// un projet ouvert hors périmètre ne fuit vers aucun autre dossier).
pub fn preview_read_core(
    cache_dir: &Path,
    project: Option<&str>,
    source_input: &str,
    name: Option<&str>,
    disable_cdn_loading: bool,
) -> Result<PreviewReadOut, String> {
    let banner = if disable_cdn_loading {
        Some(PREVIEW_OFFLINE_BANNER.to_string())
    } else {
        None
    };
    let fail = |source: String,
                name: Option<String>,
                message: String,
                banner: Option<String>| {
        PreviewReadOut {
            found: false,
            source,
            name,
            data_url: None,
            bytes: 0,
            width: None,
            height: None,
            preview_url: None,
            updated_at: None,
            banner,
            message: Some(message),
            errors: 1,
            warnings: 0,
        }
    };
    let proj = require_open_project(project, "preview_screenshot")?;
    let reg = crate::project::load_registry_file(cache_dir);
    let dir = crate::project::assert_project_member(&proj, &reg)?;
    let previews = crate::project::project_paths(&dir).previews;
    let Some(source) = crate::preview::normalize_source(source_input) else {
        return Ok(fail(
            source_input.trim().to_string(),
            None,
            format!(
                "source screenshot inconnue \"{}\" (attendues : schematic_2d, pcb_2d, pcb_3d, alias prototype \"schematique_2d\" accepté)",
                source_input.trim()
            ),
            banner,
        ));
    };
    let wanted = crate::preview::sanitize_preview_name(name);
    let (file_path, resolved_name) = match wanted {
        Some(slug) => (
            crate::preview::preview_png_path(&previews, source, Some(&slug)),
            Some(slug),
        ),
        None => match latest_preview_in(&previews, source) {
            Some(hit) => hit,
            None => {
                return Ok(fail(
                    source.to_string(),
                    None,
                    format!(
                        "aucun screenshot pour {source} — ouvre l'app, affiche l'onglet {} puis clique « Screenshot agent ». {PREVIEW_NO_GPU_FALLBACK}",
                        tab_name(source)
                    ),
                    banner,
                ));
            }
        },
    };
    if !file_path.exists() {
        let suffix = resolved_name
            .as_deref()
            .map(|n| format!(" ({n})"))
            .unwrap_or_default();
        return Ok(fail(
            source.to_string(),
            resolved_name,
            format!(
                "aucun screenshot pour {source}{suffix} — ouvre l'app, affiche l'onglet {} puis clique « Screenshot agent ». {PREVIEW_NO_GPU_FALLBACK}",
                tab_name(source)
            ),
            banner,
        ));
    }
    // Fichier présent mais illisible (race suppression, permissions) : refus
    // explicite `Ok` comme le sidecar, jamais d'erreur dure.
    let bytes = match std::fs::read(&file_path) {
        Ok(b) => b,
        Err(e) => {
            return Ok(fail(
                source.to_string(),
                resolved_name,
                format!("screenshot illisible pour {source} : {e}"),
                banner,
            ));
        }
    };
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let (mut width, mut height, mut updated_at) = (None, None, None);
    if let Ok(meta_raw) = std::fs::read_to_string(crate::preview::preview_meta_path(
        &previews,
        source,
        resolved_name.as_deref(),
    )) {
        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_raw) {
            if let Some(w) = meta.get("width").and_then(|v| v.as_u64()) {
                if w > 0 {
                    width = Some(w as u32);
                }
            }
            if let Some(h) = meta.get("height").and_then(|v| v.as_u64()) {
                if h > 0 {
                    height = Some(h as u32);
                }
            }
            if let Some(u) = meta.get("updatedAt").and_then(|v| v.as_str()) {
                updated_at = Some(u.to_string());
            }
        }
    }
    if width.is_none() || height.is_none() {
        if let Some((w, h)) = png_dimensions(&bytes) {
            if width.is_none() {
                width = Some(w);
            }
            if height.is_none() {
                height = Some(h);
            }
        }
    }
    Ok(PreviewReadOut {
        found: true,
        source: source.to_string(),
        name: resolved_name,
        data_url: Some(format!("data:image/png;base64,{b64}")),
        bytes: bytes.len() as u64,
        width,
        height,
        preview_url: Some(file_url(&file_path)),
        updated_at,
        banner,
        message: None,
        errors: 0,
        warnings: 0,
    })
}

// --- Commandes fines (enregistrement seul dans `lib.rs`, hunks T5-agent) ----

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentFetchOut {
    pub status: u16,
    pub body: String,
}

/// Proxy sourcing allowlisté (le frontend ne fait aucun appel réseau
/// direct). Exige un Projet ouvert, comme `search_parts` côté MCP.
#[tauri::command]
pub async fn agent_fetch(
    state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::BootState>>>,
    url: String,
) -> Result<AgentFetchOut, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    require_open_project(project.as_deref(), "search_parts")?;
    if !is_fetch_allowed(&url) {
        return Err(format!(
            "hôte refusé (allowlist sourcing JLCPCB-first) : {url}"
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("client HTTP indisponible : {e}"))?;
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("recherche JLCPCB interrompue (timeout 15 s) pour {url} : réessayez")
            } else {
                format!("recherche JLCPCB impossible : {e} — réessayez en ligne")
            }
        })?;
    let status = res.status().as_u16();
    let body = res
        .text()
        .await
        .map_err(|e| format!("réponse sourcing illisible : {e}"))?;
    Ok(AgentFetchOut { status, body })
}

/// Persistance atomique du Lot (point de commit unique : `applied:true`
/// seulement après succès disque).
#[tauri::command]
pub fn agent_commit_files(
    path: String,
    code: String,
    circuit_json: Vec<serde_json::Value>,
) -> Result<CommitResult, String> {
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    commit_files_core(&cache, &path, &code, &circuit_json)
}

/// Écriture atomique des artefacts fab (règle `<projet>/exports/<base>-<hash12>`).
#[tauri::command]
pub fn agent_fab_write(
    path: String,
    #[allow(unused_variables)] project_name: Option<String>,
    files: Vec<FabFileIn>,
) -> Result<FabWriteResult, String> {
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    // `project_name` : le nommage KiCad est porté par les noms de fichiers
    // (calculés côté routeur via `exportFab`) ; le backend ne fait que
    // vérifier, créer le dossier et écrire (pas de renommage silencieux).
    fab_write_core(&cache, &path, &files)
}

/// Lecture capture (résolution + messages VERBATIM du sidecar).
#[tauri::command]
pub fn agent_preview_read(
    state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::BootState>>>,
    source: String,
    name: Option<String>,
    disable_cdn_loading: Option<bool>,
) -> Result<PreviewReadOut, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    preview_read_core(
        &cache,
        project.as_deref(),
        &source,
        name.as_deref(),
        disable_cdn_loading.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let b = std::env::temp_dir().join(format!("nia-agent-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        std::fs::create_dir_all(&b).unwrap();
        b
    }

    fn registered(cache: &Path, dir: &Path) -> crate::project::Registry {
        let mut reg = crate::project::Registry::default();
        crate::project::upsert_registry(
            &mut reg,
            dir.to_str().unwrap(),
            "2026-01-01T00:00:00Z",
        );
        crate::project::save_registry_file(cache, &reg).unwrap();
        reg
    }

    // --- RED : allowlist deny-prioritaire ---------------------------------

    #[test]
    fn fetch_allowlist_jlcsearch_seul() {
        assert!(is_fetch_allowed(
            "https://jlcsearch.tscircuit.com/api/search?q=10k"
        ));
        assert!(is_fetch_allowed(
            "https://jlcsearch.tscircuit.com/components/list.json?search=C21190"
        ));
        assert!(is_fetch_allowed(
            "https://jlcsearch.tscircuit.com/api/footprinter_strings/C21190"
        ));
        assert!(!is_fetch_allowed("https://jlcsearch.tscircuit.com/"));
        assert!(!is_fetch_allowed("http://jlcsearch.tscircuit.com/api/search?q=x"));
        assert!(!is_fetch_allowed(
            "https://jlcsearch.tscircuit.com.evil.com/api/search?q=x"
        ));
        assert!(!is_fetch_allowed("https://api.meta.ai/v1/models"));
        assert!(!is_fetch_allowed("https://example.com/"));
        assert!(!is_fetch_allowed(""));
    }

    #[test]
    fn garde_projet_ouvert_exigee() {
        assert!(require_open_project(Some("/p"), "search_parts").is_ok());
        let err = require_open_project(None, "search_parts").expect_err("sans projet");
        assert!(err.contains(NO_PROJECT_OPEN), "{err}");
        assert!(err.contains("search_parts"), "{err}");
        let err = require_open_project(Some("  "), "search_parts").expect_err("vide");
        assert!(err.contains(NO_PROJECT_OPEN), "{err}");
    }

    // --- RED : nommage export ----------------------------------------------

    #[test]
    fn segments_export_assainis() {
        assert_eq!(sanitize_export_segment("ma-carte_v2"), "ma-carte_v2");
        assert_eq!(sanitize_export_segment("a/b c"), "a-b-c");
        assert_eq!(sanitize_export_segment(""), "default");
        assert_eq!(sanitize_export_segment("---"), "default");
        assert_eq!(export_project_name("default"), "board");
        assert_eq!(export_project_name("ma carte!"), "ma-carte");
    }

    #[test]
    fn dossier_export_basename_hash12() {
        // Vecteur figé (règle partagée sidecar) : `exports/<base>-<sha256:12>`.
        let dir = PathBuf::from("/tmp/nia-carte");
        let out = export_dir_for(&dir);
        assert_eq!(out.parent().unwrap().file_name().unwrap(), "exports");
        let leaf = out.file_name().unwrap().to_string_lossy().into_owned();
        assert!(leaf.starts_with("nia-carte-"), "{leaf}");
        assert_eq!(leaf, format!("nia-carte-{}", sha256_hex12("/tmp/nia-carte")));
        assert_eq!(sha256_hex12("/tmp/nia-carte").len(), 12);
        // Homonymes distingués : parents différents → hash différents.
        assert_ne!(
            sha256_hex12("/a/p1/carte"),
            sha256_hex12("/b/p2/carte"),
            "homonymes distingués"
        );
    }

    #[test]
    fn file_url_encode() {
        assert_eq!(
            file_url(Path::new("/tmp/nia-carte/x.png")),
            "file:///tmp/nia-carte/x.png"
        );
        assert!(file_url(Path::new("/tmp/ma carte/x.png")).contains("%20"));
    }

    // --- RED : commit atomique -----------------------------------------------

    #[test]
    fn commit_ecrit_main_et_circuit_versionne() {
        let base = tmp("commit");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        registered(&cache, &dir);
        let circuit = vec![serde_json::json!({"type": "source"})];
        let out = commit_files_core(&cache, dir.to_str().unwrap(), "code-a", &circuit)
            .expect("commit");
        assert_eq!(out.circuit_ok, true);
        assert!(!out.code_hash.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("main.tsx")).unwrap(), "code-a");
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("circuit.json")).unwrap())
                .unwrap();
        assert_eq!(raw.get("version").and_then(|v| v.as_u64()), Some(1));
        // Pas de tmp résiduel.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn commit_hors_perimetre_refuse_disque_intact() {
        let base = tmp("commit-hors");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.tsx"), "origine").unwrap();
        // Registre vide : hors périmètre.
        crate::project::save_registry_file(&cache, &crate::project::Registry::default())
            .unwrap();
        let err = commit_files_core(&cache, dir.to_str().unwrap(), "pirate", &[])
            .expect_err("hors périmètre");
        assert!(err.contains("hors périmètre"), "{err}");
        assert_eq!(
            std::fs::read_to_string(dir.join("main.tsx")).unwrap(),
            "origine",
            "disque intact"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- RED : fab_write -------------------------------------------------------

    #[test]
    fn fab_write_artefacts_et_regle_dossier() {
        use base64::Engine as _;
        let base = tmp("fab");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        registered(&cache, &dir);
        let enc = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
        let out = fab_write_core(
            &cache,
            dir.to_str().unwrap(),
            &[
                FabFileIn { name: "gerbers/F_Cu.gtl".into(), base64: enc("cuivre") },
                FabFileIn { name: "bom.csv".into(), base64: enc("a,b") },
            ],
        )
        .expect("fab_write");
        assert_eq!(out.export_dir, export_dir_for(&dir).to_string_lossy());
        assert_eq!(out.artifacts.len(), 2);
        assert_eq!(out.artifacts[0].bytes, 6);
        assert!(out.artifacts[0].preview_url.starts_with("file://"));
        assert!(out.artifacts[0].preview_url.ends_with("gerbers/F_Cu.gtl"));
        assert_eq!(
            std::fs::read(out.export_dir.clone() + "/bom.csv").unwrap(),
            b"a,b"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fab_write_traversal_refuse() {
        let base = tmp("fab-trav");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        registered(&cache, &dir);
        for evil in ["../evil.csv", "/absolu.csv", "gerbers/../../x"] {
            let err = fab_write_core(
                &cache,
                dir.to_str().unwrap(),
                &[FabFileIn { name: evil.into(), base64: "".into() }],
            )
            .expect_err("traversal refusé");
            assert!(err.contains("Confinement"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- RED : preview_read (VERBATIM sidecar) ---------------------------------

    /// PNG 1×1 (IHDR 1×1) + méta, dépôt manuel sans `.json` pour le 2e cas.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49,
        0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
        0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
    ];

    fn seed_previews(base: &Path, dir: &Path) {
        let prev = dir.join("previews");
        std::fs::create_dir_all(&prev).unwrap();
        std::fs::write(prev.join("pcb_2d.png"), PNG_1X1).unwrap();
        std::fs::write(
            prev.join("pcb_2d.json"),
            r#"{"width":800,"height":600,"updatedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        let _ = base;
    }

    #[test]
    fn preview_dimensions_png() {
        assert_eq!(png_dimensions(PNG_1X1), Some((1, 1)));
        assert_eq!(png_dimensions(b"pas un png"), None);
        assert_eq!(png_dimensions(&[]), None);
    }

    #[test]
    fn preview_lit_dernier_avec_meta() {
        let base = tmp("prev");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        registered(&cache, &dir);
        seed_previews(&base, &dir);
        let out = preview_read_core(
            &cache,
            Some(dir.to_str().unwrap()),
            "pcb_2d",
            None,
            false,
        )
        .expect("lecture");
        assert!(out.found);
        assert_eq!(out.source, "pcb_2d");
        assert_eq!(out.bytes, PNG_1X1.len() as u64);
        assert_eq!(out.width, Some(800));
        assert_eq!(out.height, Some(600));
        assert_eq!(out.updated_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert!(out.data_url.unwrap().starts_with("data:image/png;base64,"));
        assert!(out.preview_url.unwrap().ends_with("previews/pcb_2d.png"));
        assert_eq!(out.banner, None);
        assert_eq!((out.errors, out.warnings), (0, 0));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn preview_alias_et_nomme_et_repli_png() {
        let base = tmp("prev-alias");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        registered(&cache, &dir);
        let prev = dir.join("previews");
        std::fs::create_dir_all(&prev).unwrap();
        // Dépôt manuel SANS méta → repli en-tête PNG (1×1).
        std::fs::write(prev.join("pcb_2d__revue.png"), PNG_1X1).unwrap();
        // Alias prototype accepté.
        let out = preview_read_core(
            &cache,
            Some(dir.to_str().unwrap()),
            "schematique_2d",
            None,
            false,
        )
        .expect("alias");
        assert!(!out.found, "pas de schematic : refus explicite");
        assert!(out.message.unwrap().contains("aucun screenshot pour schematic_2d"));
        // Nommé explicite.
        let out = preview_read_core(
            &cache,
            Some(dir.to_str().unwrap()),
            "pcb",
            Some("revue"),
            false,
        )
        .expect("nommé");
        assert!(out.found);
        assert_eq!(out.source, "pcb_2d");
        assert_eq!(out.name.as_deref(), Some("revue"));
        assert_eq!((out.width, out.height), (Some(1), Some(1)));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn preview_refus_verbatim() {
        let base = tmp("prev-refus");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        registered(&cache, &dir);
        std::fs::create_dir_all(dir.join("previews")).unwrap();
        // Source inconnue : sortie Ok VERBATIM.
        let out = preview_read_core(
            &cache,
            Some(dir.to_str().unwrap()),
            "topo",
            None,
            true,
        )
        .expect("refus source");
        assert!(!out.found);
        assert_eq!(out.source, "topo");
        assert!(out.message.unwrap().contains("source screenshot inconnue"));
        assert!(out.banner.is_some(), "bandeau offline");
        // Screenshot absent : sortie Ok VERBATIM.
        let out = preview_read_core(
            &cache,
            Some(dir.to_str().unwrap()),
            "pcb_3d",
            None,
            false,
        )
        .expect("refus absent");
        assert!(!out.found);
        let msg = out.message.unwrap();
        assert!(msg.contains("aucun screenshot pour pcb_3d"), "{msg}");
        assert!(msg.contains("Screenshot agent"), "{msg}");
        // Sans projet : erreur NO_PROJECT_OPEN.
        let err = preview_read_core(&cache, None, "pcb_2d", None, false)
            .expect_err("sans projet");
        assert!(err.contains(NO_PROJECT_OPEN), "{err}");
        // Hors Registre : Confinement.
        let outsider = base.join("outsider");
        std::fs::create_dir_all(&outsider).unwrap();
        let err = preview_read_core(
            &cache,
            Some(outsider.to_str().unwrap()),
            "pcb_2d",
            None,
            false,
        )
        .expect_err("hors périmètre");
        assert!(err.contains("hors périmètre"), "{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn preview_illisible_refus_ok_verbatim() {
        let base = tmp("prev-illisible");
        let cache = base.join("cache");
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        registered(&cache, &dir);
        let prev = dir.join("previews");
        std::fs::create_dir_all(&prev).unwrap();
        // Présent mais illisible (dossier à la place du PNG) : refus `Ok`
        // VERBATIM sidecar, pas d'erreur dure.
        std::fs::create_dir_all(prev.join("pcb_2d.png")).unwrap();
        let out = preview_read_core(
            &cache,
            Some(dir.to_str().unwrap()),
            "pcb_2d",
            None,
            false,
        )
        .expect("refus explicite");
        assert!(!out.found);
        assert!(out.message.unwrap().contains("screenshot illisible pour pcb_2d"));
        assert_eq!(out.errors, 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
