//! Projets dossier (Accueil + MCP scopé).
//!
//! Seam A (pur, sans GUI) : validation chemins absolus, layout
//! `main.tsx / circuit.json / previews/ / exports/`, gabarits vide/demo,
//! Registre sérialisable. L'I/O Tauri (app_config, lockfile) vit dans lib.rs.

use std::path::{Component, Path, PathBuf};

pub const MAIN_FILE: &str = "main.tsx";
pub const CIRCUIT_FILE: &str = "circuit.json";
pub const PREVIEWS_DIR: &str = "previews";
pub const EXPORTS_DIR: &str = "exports";

pub const DEMO_CODE: &str = r#"export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={-4} />
    <chip name="U1" footprint="sot23" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .pin1" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin3" to="net.VCC" />
  </board>
)
"#;

pub const EMPTY_CODE: &str = r#"export default () => (
  <board width="20mm" height="20mm" />
)
"#;

/// Gabarit accepté par `project_create` + UI.
pub fn template_code(template: &str) -> Option<&'static str> {
    match template.trim().to_lowercase().as_str() {
        "vide" | "empty" | "" => Some(EMPTY_CODE),
        "demo" | "gabarit démo" | "gabarit-demo" => Some(DEMO_CODE),
        _ => None,
    }
}

/// Chemin Projet : absolu normalisé uniquement, refuse vide/relatif/`..`.
pub fn validate_project_path(input: &str) -> Result<PathBuf, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("chemin projet vide".into());
    }
    let p = PathBuf::from(raw);
    if !p.is_absolute() {
        return Err("chemin absolu requis".into());
    }
    for comp in p.components() {
        if matches!(comp, Component::ParentDir) {
            return Err("traversal .. refusé".into());
        }
    }
    Ok(p)
}

pub struct ProjectPaths {
    pub main: PathBuf,
    pub circuit: PathBuf,
    pub previews: PathBuf,
    pub exports: PathBuf,
}

pub fn project_paths(dir: &Path) -> ProjectPaths {
    ProjectPaths {
        main: dir.join(MAIN_FILE),
        circuit: dir.join(CIRCUIT_FILE),
        previews: dir.join(PREVIEWS_DIR),
        exports: dir.join(EXPORTS_DIR),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InitOutcome {
    Created,
    AlreadyExists,
}

/// Crée le layout Projet. Refuse dossier non-vide sans `main.tsx`.
pub fn ensure_project_layout(dir: &Path, template: &str) -> Result<InitOutcome, String> {
    let code = template_code(template)
        .ok_or_else(|| format!("gabarit inconnu \"{template}\" (attendus : vide, demo)"))?;
    let paths = project_paths(dir);
    let existed_before = dir.exists();
    std::fs::create_dir_all(&paths.previews).map_err(|e| format!("création previews : {e}"))?;
    std::fs::create_dir_all(&paths.exports).map_err(|e| format!("création exports : {e}"))?;
    if paths.main.exists() {
        return Ok(InitOutcome::AlreadyExists);
    }
    if existed_before {
        let non_empty = std::fs::read_dir(dir)
            .map_err(|e| format!("lecture dossier : {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != PREVIEWS_DIR && n != EXPORTS_DIR)
            .count();
        if non_empty > 0 {
            return Err("dossier non-vide sans main.tsx : refuse d'écraser".into());
        }
    } else {
        std::fs::create_dir_all(dir).map_err(|e| format!("création dossier projet : {e}"))?;
    }
    std::fs::write(&paths.main, code).map_err(|e| format!("écriture main.tsx : {e}"))?;
    if !paths.circuit.exists() {
        std::fs::write(&paths.circuit, "[]").map_err(|e| format!("écriture circuit.json : {e}"))?;
    }
    Ok(InitOutcome::Created)
}

// --- Registre ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RegistryEntry {
    pub path: String,
    #[serde(rename = "lastOpened")]
    pub last_opened: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct Registry {
    #[serde(default)]
    pub projects: Vec<RegistryEntry>,
    #[serde(rename = "lastOpened", default)]
    pub last_opened: Option<String>,
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn upsert_registry(reg: &mut Registry, path: &str, now: &str) {
    let p = path.to_string();
    if let Some(e) = reg.projects.iter_mut().find(|e| e.path == p) {
        e.last_opened = now.to_string();
    } else {
        reg.projects.push(RegistryEntry {
            path: p.clone(),
            last_opened: now.to_string(),
        });
    }
    // Tri lastOpened desc (lexicographique RFC3339 = chronologique).
    reg.projects
        .sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    reg.last_opened = Some(p);
}

pub fn forget_registry(reg: &mut Registry, path: &str) {
    reg.projects.retain(|e| e.path != path);
    if reg.last_opened.as_deref() == Some(path) {
        reg.last_opened = reg.projects.first().map(|e| e.path.clone());
        // Si vide, None.
        if reg.projects.is_empty() {
            reg.last_opened = None;
        }
    }
}

pub fn parse_registry(text: &str) -> Result<Registry, String> {
    if text.trim().is_empty() {
        return Ok(Registry::default());
    }
    serde_json::from_str(text).map_err(|e| format!("registre illisible : {e}"))
}

pub fn serialize_registry(reg: &Registry) -> Result<String, String> {
    serde_json::to_string_pretty(reg).map_err(|e| format!("sérialisation registre : {e}"))
}

// --- Persistance partagée Rust ↔ sidecar ------------------------------------
// Le Registre + `projectPath` vivent sous `base cache/niatscircuit/` (même
// raison que le lockfile bug #25 : le sidecar Node calcule le même chemin
// sans AppHandle). Regroupés ici pour éviter la dispersion (review).

/// `base cache/niatscircuit/projects.json`.
pub fn registry_file(cache_dir: &Path) -> PathBuf {
    cache_dir.join(crate::boot::REGISTRY_REL)
}

/// Charge le Registre depuis le cache de base (défaut vide).
pub fn load_registry_file(cache_dir: &Path) -> Registry {
    let text = std::fs::read_to_string(registry_file(cache_dir)).unwrap_or_default();
    parse_registry(&text).unwrap_or_default()
}

/// Sauvegarde le Registre (crée les parents).
pub fn save_registry_file(cache_dir: &Path, reg: &Registry) -> Result<(), String> {
    let file = registry_file(cache_dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("création registre : {e}"))?;
    }
    let text = serialize_registry(reg)?;
    std::fs::write(&file, text).map_err(|e| format!("écriture registre : {e}"))?;
    Ok(())
}

/// Met à jour `projectPath` du lockfile best-effort (partage Rust ↔ sidecar).
pub fn write_lock_project(cache_dir: &Path, project: Option<&str>) {
    let path = crate::boot::lockfile_path(cache_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut data) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    match project {
        Some(p) => data["projectPath"] = serde_json::Value::String(p.to_string()),
        None => {
            if let Some(obj) = data.as_object_mut() {
                obj.remove("projectPath");
            }
        }
    }
    let Ok(out) = serde_json::to_string_pretty(&data) else {
        return;
    };
    let _ = std::fs::write(&path, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valide_absolu_refuse_relatif_et_traversal() {
        assert!(validate_project_path("/tmp/projet-a").is_ok());
        assert!(validate_project_path("").is_err());
        assert!(validate_project_path("relatif/projet").is_err());
        assert!(validate_project_path("/tmp/../etc").is_err());
        assert!(validate_project_path("/tmp/a/../b").is_err());
    }

    #[test]
    fn gabarits_vide_par_defaut_demo_optionnel() {
        assert_eq!(template_code("vide"), Some(EMPTY_CODE));
        assert_eq!(template_code(""), Some(EMPTY_CODE));
        assert_eq!(template_code("demo"), Some(DEMO_CODE));
        assert!(template_code("inconnu").is_none());
    }

    #[test]
    fn layout_cree_fichiers_puis_idempotent() {
        let base = std::env::temp_dir().join(format!("nia-proj-{}", std::process::id()));
        let dir = base.join("layout-a");
        let _ = std::fs::remove_dir_all(&dir);
        let out = ensure_project_layout(&dir, "vide").expect("création");
        assert_eq!(out, InitOutcome::Created);
        assert!(dir.join("main.tsx").exists());
        assert!(dir.join("circuit.json").exists());
        assert!(dir.join("previews").is_dir());
        assert!(dir.join("exports").is_dir());
        let again = ensure_project_layout(&dir, "vide").expect("idempotent");
        assert_eq!(again, InitOutcome::AlreadyExists);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn layout_refuse_non_vide_sans_main() {
        let base = std::env::temp_dir().join(format!("nia-proj-refuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("notes.txt"), "ne pas écraser").unwrap();
        assert!(ensure_project_layout(&base, "vide").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn registre_upsert_tri_et_oubli() {
        let mut reg = Registry::default();
        upsert_registry(&mut reg, "/p/b", "2026-01-01T00:00:00Z");
        upsert_registry(&mut reg, "/p/a", "2026-01-02T00:00:00Z");
        assert_eq!(reg.projects[0].path, "/p/a");
        assert_eq!(reg.last_opened.as_deref(), Some("/p/a"));
        // Re-touch b le remonte.
        upsert_registry(&mut reg, "/p/b", "2026-01-03T00:00:00Z");
        assert_eq!(reg.projects[0].path, "/p/b");
        forget_registry(&mut reg, "/p/b");
        assert_eq!(reg.projects.len(), 1);
        assert_eq!(reg.last_opened.as_deref(), Some("/p/a"));
        forget_registry(&mut reg, "/p/a");
        assert!(reg.projects.is_empty());
        assert_eq!(reg.last_opened, None);
    }

    #[test]
    fn registre_roundtrip_vide_et_invalide() {
        let reg = parse_registry("").expect("vide = défaut");
        assert!(reg.projects.is_empty());
        assert!(parse_registry("{ pas json").is_err());
        let mut r2 = Registry::default();
        upsert_registry(&mut r2, "/x", "2026-01-01T00:00:00Z");
        let s = serialize_registry(&r2).expect("sérialise");
        let back = parse_registry(&s).expect("re-lit");
        assert_eq!(back, r2);
    }
}
