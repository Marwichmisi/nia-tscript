//! Screenshots preview partagés WebView ↔ MCP (#15 + capture nommée Q10).
//!
//! La WebView dépose les PNG via `save_screenshot` dans
//! `<projet>/previews/<source>[__<nom>].png` (+ `.json`) si Projet ouvert,
//! sinon `cache_dir/niatscircuit/previews/` ; le sidecar lit en priorité
//! le dossier projet. Jamais d'image inventée.

use std::path::{Path, PathBuf};

/// Sources canoniques (+ alias prototype `schematique_2d`).
#[allow(dead_code)]
pub const PREVIEW_SOURCES: &[&str] = &["schematic_2d", "pcb_2d", "pcb_3d"];

/// Normalise une source (alias `schematique_2d` → `schematic_2d`).
pub fn normalize_source(input: &str) -> Option<&'static str> {
    let raw = input.trim();
    match raw {
        "schematic_2d" => Some("schematic_2d"),
        "pcb_2d" => Some("pcb_2d"),
        "pcb_3d" => Some("pcb_3d"),
        "schematique_2d" | "schematic" | "schema" => Some("schematic_2d"),
        "pcb" => Some("pcb_2d"),
        "3d" => Some("pcb_3d"),
        _ => None,
    }
}

/// Dossier partagé sous le cache Tauri.
pub fn preview_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("niatscircuit").join("previews")
}

pub fn preview_png_path(dir: &Path, source: &str, name: Option<&str>) -> PathBuf {
    match sanitize_preview_name(name) {
        Some(slug) => dir.join(format!("{source}__{slug}.png")),
        None => dir.join(format!("{source}.png")),
    }
}

pub fn preview_meta_path(dir: &Path, source: &str, name: Option<&str>) -> PathBuf {
    match sanitize_preview_name(name) {
        Some(slug) => dir.join(format!("{source}__{slug}.json")),
        None => dir.join(format!("{source}.json")),
    }
}

/// Nom de capture agent (Q10) : slug `a-z0-9-_`, max 32, vide → None.
pub fn sanitize_preview_name(name: Option<&str>) -> Option<String> {
    let raw = name.unwrap_or("").trim();
    if raw.is_empty() {
        return None;
    }
    let mut slug: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    while slug.starts_with('-') || slug.starts_with('_') {
        slug.remove(0);
    }
    while slug.ends_with('-') || slug.ends_with('_') {
        slug.pop();
    }
    // Collapse `--` → `-` (lisibilité, un seul passage suffit au MVP).
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug.truncate(32);
    while slug.ends_with('-') || slug.ends_with('_') {
        slug.pop();
    }
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

/// Plafond capture (ticket #42) : refus au-delà de 20 Mo.
pub const PREVIEW_MAX_BYTES: usize = 20 * 1024 * 1024;

/// Plafond captures par dossier (ticket #42) : 50 fichiers, éviction LRU.
pub const PREVIEW_MAX_FILES: usize = 50;

/// Compteur exposé pour la future GC : captures PNG + octets du dossier.
pub fn preview_count(dir: &Path) -> (usize, u64) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (0, 0),
    };
    let mut files = 0usize;
    let mut bytes = 0u64;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

/// Évince les captures les moins récentes au-delà du plafond (avec leur
/// méta JSON). Retourne `(évincés, total_restant)`.
pub fn enforce_preview_quota(dir: &Path) -> (usize, usize) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (0, 0),
    };
    let mut pngs: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        pngs.push((p, mtime));
    }
    pngs.sort_by(|a, b| a.1.cmp(&b.1));
    let mut evicted = 0usize;
    while pngs.len() > PREVIEW_MAX_FILES {
        let (oldest, _) = pngs.remove(0);
        let _ = std::fs::remove_file(&oldest);
        let _ = std::fs::remove_file(oldest.with_extension("json"));
        evicted += 1;
    }
    (evicted, preview_count(dir).0)
}

/// Valide une dataURL PNG et retourne (octets, largeur, hauteur).
/// Les dimensions fournies par l'appelant (bounding rect canvas/SVG)
/// priment si > 0, sinon lecture de l'en-tête IHDR.
pub fn validate_png_data_url(
    data_url: &str,
    width: u32,
    height: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    const PREFIX: &str = "data:image/png;base64,";
    let b64 = data_url
        .strip_prefix(PREFIX)
        .ok_or_else(|| "screenshot attendu en PNG dataURL (data:image/png;base64,…)".to_string())?;
    use base64::Engine as _;
    let buf = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 PNG illisible : {e}"))?;
    if buf.len() < 8 || buf[0..4] != [0x89, 0x50, 0x4E, 0x47] {
        return Err("octets PNG invalides (magie PNG absente)".into());
    }
    if width > 0 && height > 0 {
        return Ok((buf, width, height));
    }
    png_dimensions(&buf)
        .map(|(w, h)| (buf, w, h))
        .ok_or_else(|| "dimensions PNG illisibles et non fournies".to_string())
}

/// Dimensions depuis l'en-tête IHDR (sans dépendance image).
pub fn png_dimensions(buf: &[u8]) -> Option<(u32, u32)> {
    if buf.len() < 24 {
        return None;
    }
    if buf[0..4] != [0x89, 0x50, 0x4E, 0x47] {
        return None;
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct SavedPreview {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    pub path: String,
    #[serde(rename = "previewUrl")]
    pub preview_url: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    /// Captures PNG conservées après éviction LRU (compteur GC).
    #[serde(rename = "totalFiles")]
    pub total_files: usize,
    /// Fichiers évincés par ce dépôt (0 en régime normal).
    pub evicted: usize,
}

/// Écrit le PNG + métadonnées JSON dans `dir` (créé si besoin).
pub fn write_preview(
    dir: &Path,
    source: &str,
    data_url: &str,
    width: u32,
    height: u32,
    name: Option<&str>,
) -> Result<SavedPreview, String> {
    let canonical = normalize_source(source)
        .ok_or_else(|| format!("source screenshot inconnue \"{source}\" (attendues : schematic_2d, pcb_2d, pcb_3d)"))?;
    let (buf, w, h) = validate_png_data_url(data_url, width, height)?;
    // Quota taille (#42) : refus AVANT toute écriture, dossier inchangé.
    if buf.len() > PREVIEW_MAX_BYTES {
        return Err(format!(
            "capture trop lourde ({} octets > 20 Mo) : réduisez la zone ou la résolution — jamais de capture partielle inventée",
            buf.len()
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("création dossier previews : {e}"))?;
    let slug = sanitize_preview_name(name);
    let png_path = preview_png_path(dir, canonical, slug.as_deref());
    std::fs::write(&png_path, &buf).map_err(|e| format!("écriture PNG : {e}"))?;
    let updated_at = chrono::Utc::now().to_rfc3339();
    let preview_url = format!("file://{}", png_path.to_string_lossy());
    // Quota nombre (#42) : éviction LRU au-delà de 50, compteur exposé.
    let (evicted, total_files) = enforce_preview_quota(dir);
    let saved = SavedPreview {
        source: canonical.to_string(),
        name: slug.clone(),
        bytes: buf.len(),
        width: w,
        height: h,
        path: png_path.to_string_lossy().to_string(),
        preview_url: preview_url.clone(),
        updated_at: updated_at.clone(),
        total_files,
        evicted,
    };
    let meta = serde_json::json!({
        "source": saved.source,
        "name": saved.name,
        "bytes": saved.bytes,
        "width": saved.width,
        "height": saved.height,
        "previewUrl": preview_url,
        "updatedAt": updated_at,
    });
    let meta_text =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("sérialisation meta : {e}"))?;
    std::fs::write(preview_meta_path(dir, canonical, slug.as_deref()), meta_text)
        .map_err(|e| format!("écriture meta : {e}"))?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIXEL_1X1: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn normalize_sources_et_alias() {
        assert_eq!(normalize_source("schematic_2d"), Some("schematic_2d"));
        assert_eq!(normalize_source("pcb_2d"), Some("pcb_2d"));
        assert_eq!(normalize_source("pcb_3d"), Some("pcb_3d"));
        assert_eq!(normalize_source("schematique_2d"), Some("schematic_2d"));
        assert_eq!(normalize_source("gerber_layer"), None);
    }

    #[test]
    fn preview_dir_sous_cache() {
        let p = preview_dir(Path::new("/tmp/Cache"));
        assert_eq!(p, PathBuf::from("/tmp/Cache/niatscircuit/previews"));
    }

    #[test]
    fn validate_png_1x1() {
        let (buf, w, h) = validate_png_data_url(PIXEL_1X1, 0, 0).expect("1x1 valide");
        assert!(buf.len() > 50);
        assert_eq!((w, h), (1, 1));
        let (_, w2, h2) = validate_png_data_url(PIXEL_1X1, 1238, 612).expect("dims appelant");
        assert_eq!((w2, h2), (1238, 612));
        assert!(validate_png_data_url("data:image/jpeg;base64,/9j/", 0, 0).is_err());
    }

    #[test]
    fn write_puis_meta() {
        let dir = std::env::temp_dir().join(format!("nia-preview-rs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let saved = write_preview(&dir, "pcb_2d", PIXEL_1X1, 10, 20, None).expect("write");
        assert_eq!(saved.width, 10);
        assert_eq!(saved.height, 20);
        assert!(saved.preview_url.starts_with("file://"));
        assert!(preview_png_path(&dir, "pcb_2d", None).exists());
        assert!(preview_meta_path(&dir, "pcb_2d", None).exists());
        let named = write_preview(&dir, "pcb_2d", PIXEL_1X1, 10, 20, Some("verif-xyz")).expect("write nommé");
        assert_eq!(named.name.as_deref(), Some("verif-xyz"));
        assert!(preview_png_path(&dir, "pcb_2d", Some("verif-xyz")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_nom_capture() {
        assert_eq!(sanitize_preview_name(None), None);
        assert_eq!(sanitize_preview_name(Some("")), None);
        assert_eq!(sanitize_preview_name(Some("verif-xyz")), Some("verif-xyz".to_string()));
        assert_eq!(sanitize_preview_name(Some("  A B/C ")), Some("A-B-C".to_string()));
    }

    #[test]
    fn write_rejette_source_inconnue() {
        let dir = std::env::temp_dir().join(format!("nia-preview-rs-bad-{}", std::process::id()));
        assert!(write_preview(&dir, "gerber_layer", PIXEL_1X1, 1, 1, None).is_err());
    }

    // --- Ticket #42 : quotas captures (20 Mo max, 50 fichiers LRU) --------

    fn quota_png(name: &str, dir: &Path) -> PathBuf {
        preview_png_path(dir, "pcb_2d", Some(name))
    }

    #[test]
    fn refuse_au_dela_de_20_mo_sans_ecrire() {
        let dir = std::env::temp_dir().join(format!("nia-preview-rs-big-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut buf = vec![0u8; PREVIEW_MAX_BYTES + 1];
        buf[0..4].copy_from_slice(&[0x89, 0x50, 0x4E, 0x47]);
        use base64::Engine as _;
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&buf)
        );
        let err = write_preview(&dir, "pcb_2d", &data_url, 10, 10, Some("trop-gros"))
            .expect_err("20 Mo max");
        assert!(err.contains("20 Mo"), "{err}");
        assert!(!quota_png("trop-gros", &dir).exists(), "rien écrit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cinquante_et_uni_evict_le_moins_recent_compteur_expose() {
        let dir = std::env::temp_dir().join(format!("nia-preview-rs-lru-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for i in 0..50 {
            write_preview(&dir, "pcb_2d", PIXEL_1X1, 1, 1, Some(&format!("shot-{i:02}")))
                .expect(" quota remplissage");
        }
        // Vieillit artificiellement dans l'ordre d'arrivée (déterministe).
        let base = std::time::SystemTime::now() - std::time::Duration::from_secs(1000);
        for i in 0..50 {
            let t = base + std::time::Duration::from_secs(i as u64 * 10);
            let f = std::fs::File::options()
                .write(true)
                .open(quota_png(&format!("shot-{i:02}"), &dir))
                .unwrap();
            f.set_modified(t).unwrap();
        }
        let last = write_preview(&dir, "pcb_2d", PIXEL_1X1, 1, 1, Some("shot-50"))
            .expect("51e capture");
        assert!(last.evicted >= 1, "éviction LRU");
        assert_eq!(last.total_files, 50, "plafond tenu");
        assert!(!quota_png("shot-00", &dir).exists(), "la moins récente évincée");
        assert!(quota_png("shot-50", &dir).exists(), "la nouvelle conservée");
        let (files, bytes) = preview_count(&dir);
        assert_eq!(files, 50, "compteur exposé");
        assert!(bytes > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
