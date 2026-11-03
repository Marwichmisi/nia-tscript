//! Projets dossier (Accueil + MCP scopé).
//!
//! Seam A (pur, sans GUI) : validation chemins absolus, layout
//! `main.tsx / circuit.json / previews/ / exports/`, gabarits vide/demo,
//! Registre sérialisable. L'I/O Tauri (app_config, lockfile) vit dans lib.rs.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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
/// Le `..` est refusé sur le brut AVANT normalisation (Confinement) : même
/// règle que `validateProjectPath` côté sidecar.
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

/// Normalisation unique partagée (spec #37, ticket #38) : absolu, sans slash
/// final, symlinks résolus quand le dossier existe. Miroir de
/// `canonicalProjectPath` côté sidecar (`pcb-mcp/src/project.ts`).
/// Identité Registre : `upsert_registry`/`forget_registry` passent par ici
/// (l'UI oublie via le chemin stocké, donc toujours résoluble).
pub fn canonical_project_path(input: &str) -> Result<PathBuf, String> {
    let p = validate_project_path(input)?;
    // Sans slash final, sans `.` : reconstruction via composants (la racine
    // `/` se conserve telle quelle).
    let lexical: PathBuf = p.components().collect();
    if lexical.exists() {
        std::fs::canonicalize(&lexical).map_err(|e| format!("canonicalize : {e}"))
    } else {
        Ok(lexical)
    }
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
        // Projet existant : garantit quand même un circuit.json versionné.
        ensure_circuit_file(dir)?;
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
    // circuit.json versionné (ticket #38) : jamais de tableau nu sur disque.
    ensure_circuit_file(dir)?;
    Ok(InitOutcome::Created)
}

// --- circuit.json versionné (ticket #38) -----------------------------------
// Le disque est la source unique de vérité : le fichier est une enveloppe
// `{ version, circuitJson }`. Recréé (vide versionné) à l'ouverture s'il
// manque, migré si tableau nu legacy, corrompu = erreur d'ouverture visible.
// Miroir de `CIRCUIT_SCHEMA_VERSION` + `ensureCircuitFile` côté sidecar.

/// Version du schéma `circuit.json`.
pub const CIRCUIT_SCHEMA_VERSION: u32 = 1;

/// Sérialise les éléments en enveloppe versionnée.
pub fn serialize_circuit(circuit: &[serde_json::Value]) -> Result<String, String> {
    Ok(serde_json::json!({ "version": CIRCUIT_SCHEMA_VERSION, "circuitJson": circuit }).to_string())
}

/// Parse strict : enveloppe versionnée ou tableau nu legacy (migré en mémoire).
/// Erreur visible dans tous les autres cas — jamais de défaut silencieux.
pub fn parse_circuit_text(text: &str) -> Result<Vec<serde_json::Value>, String> {
    let data: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "circuit.json corrompu (JSON illisible)".to_string())?;
    if let Some(arr) = data.as_array() {
        return Ok(arr.clone());
    }
    let obj = data
        .as_object()
        .ok_or_else(|| "circuit.json corrompu (ni enveloppe ni tableau)".to_string())?;
    let version = obj.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    if version != u64::from(CIRCUIT_SCHEMA_VERSION) {
        return Err(format!(
            "circuit.json version {version} non supportée (attendue : {})",
            CIRCUIT_SCHEMA_VERSION
        ));
    }
    obj.get("circuitJson")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| "circuit.json corrompu (circuitJson absent ou invalide)".to_string())
}

/// Relit les éléments du `circuit.json` d'un Projet. Erreur si absent/corrompu.
pub fn read_circuit_file(dir: &Path) -> Result<Vec<serde_json::Value>, String> {    let text = std::fs::read_to_string(dir.join(CIRCUIT_FILE))
        .map_err(|_| format!("circuit.json absent ({}) : rouvrez le Projet", dir.display()))?;
    if text.trim().is_empty() {
        return Err(format!("circuit.json corrompu ({}) : fichier vide", dir.display()));
    }
    parse_circuit_text(&text)
}

/// Contenu `main.tsx` + hash (contrat relecture conditionnelle, ticket #43).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MainFileData {
    /// Chemin absolu du `main.tsx` lu.
    pub path: String,
    /// Code disque (source unique de vérité).
    pub code: String,
    /// Hash sha256 hex du contenu (cf. `watch::hash_main_content`).
    pub hash: String,
}

/// Relit `main.tsx` + hash depuis le disque. Erreur explicite si illisible —
/// jamais de défaut silencieux (le bandeau + toast la remontent).
pub fn read_main_file(dir: &Path) -> Result<MainFileData, String> {
    let main = dir.join(MAIN_FILE);
    let code =
        std::fs::read_to_string(&main).map_err(|e| format!("lecture main.tsx : {e}"))?;
    let hash = crate::watch::hash_main_content(code.as_bytes());
    Ok(MainFileData {
        path: main.to_string_lossy().into_owned(),
        code,
        hash,
    })
}

/// Écriture atomique de `main.tsx` (ticket #45 : coller du TSX, gabarit démo).
/// Tmp+rename+fsync via `boot::atomic_write`, puis relecture (path/code/hash).
/// Le Confinement (appartenance au Registre) est vérifié par l'appelant
/// (commande Tauri) : jamais d'écriture hors périmètre.
pub fn write_main_file(dir: &Path, code: &str) -> Result<MainFileData, String> {
    let main = project_paths(dir).main;
    crate::boot::atomic_write(&main, code.as_bytes())
        .map_err(|e| format!("écriture main.tsx : {e}"))?;
    read_main_file(dir)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitInit {
    Created,
    Migrated,
    Exists,
}

/// Garantit un `circuit.json` versionné. Corrompu → erreur (fichier préservé).
pub fn ensure_circuit_file(dir: &Path) -> Result<CircuitInit, String> {
    let circuit = dir.join(CIRCUIT_FILE);
    if !circuit.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("création dossier projet : {e}"))?;
        let text = serialize_circuit(&[])?;
        crate::boot::atomic_write(&circuit, text.as_bytes())
            .map_err(|e| format!("écriture circuit.json : {e}"))?;
        return Ok(CircuitInit::Created);
    }
    let text =
        std::fs::read_to_string(&circuit).map_err(|e| format!("lecture circuit.json : {e}"))?;
    if text.trim().is_empty() {
        return Err(format!("circuit.json corrompu ({}) : fichier vide", dir.display()));
    }
    let data: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("circuit.json corrompu ({}) : JSON illisible", dir.display()))?;
    if let Some(arr) = data.as_array() {
        let text = serialize_circuit(arr)?;
        crate::boot::atomic_write(&circuit, text.as_bytes())
            .map_err(|e| format!("écriture circuit.json : {e}"))?;
        return Ok(CircuitInit::Migrated);
    }
    parse_circuit_text(&text)?;
    Ok(CircuitInit::Exists)
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

/// Confinement (spec #37, ticket #42) : une opération dossier n'est
/// autorisée que si le chemin, APRÈS canonicalisation, est un Projet du
/// Registre. Miroir de `isProjectMember` côté sidecar.
pub fn is_project_member(input: &str, reg: &Registry) -> bool {
    let canonical = match canonical_project_path(input) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => return false,
    };
    reg.projects.iter().any(|e| {
        match canonical_project_path(&e.path) {
            Ok(p) => p.to_string_lossy() == canonical,
            Err(_) => e.path == canonical,
        }
    })
}

/// Variante qui retourne le chemin canonique ou une erreur explicite hors
/// périmètre (jamais de défaut silencieux). Miroir de `assertProjectMember`.
pub fn assert_project_member(input: &str, reg: &Registry) -> Result<PathBuf, String> {
    let canonical = canonical_project_path(input)?;
    if is_project_member(&canonical.to_string_lossy(), reg) {
        return Ok(canonical);
    }
    Err(format!(
        "hors périmètre (Confinement) : {} — opération refusée, le dossier n'est pas un Projet du Registre",
        canonical.to_string_lossy()
    ))
}

pub fn upsert_registry(reg: &mut Registry, path: &str, now: &str) {
    // Identité canonique (sans slash final, symlinks résolus si existe).
    let p = canonical_project_path(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
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
    // Même normalisation qu'à l'insertion (l'UI oublie via le chemin stocké).
    let p = canonical_project_path(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    reg.projects.retain(|e| e.path != p);
    if reg.last_opened.as_deref() == Some(p.as_str()) {
        reg.last_opened = reg.projects.first().map(|e| e.path.clone());
        // Si vide, None.
        if reg.projects.is_empty() {
            reg.last_opened = None;
        }
    }
}

// --- Ticket #42 : garde suppression backend à jeton usage unique ---------
// Le dialogue natif seul ne suffit plus (spec #37) : la suppression exige
// un jeton émis par le backend (`request_delete_token`), consommé en un
// seul usage par `delete_project_in`. L'oubli ne touche jamais au disque
// (retrait Registre seul) et il n'y a pas de corbeille en V1.

/// Jetons de suppression en attente : chemin canonique → jeton.
/// Mémoire seule, jamais persistée : un redémarrage invalide les jetons.
fn delete_tokens() -> &'static Mutex<HashMap<String, String>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Émet un jeton de suppression à usage unique pour un Projet membre.
/// Hors périmètre → erreur explicite (aucun jeton émis).
pub fn request_delete_token(reg: &Registry, path: &str) -> Result<String, String> {
    let canonical = assert_project_member(path, reg)?;
    let key = canonical.to_string_lossy().into_owned();
    let token = crate::boot::generate_token();
    delete_tokens()
        .lock()
        .expect("jetons suppression")
        .insert(key, token.clone());
    Ok(token)
}

/// Consomme le jeton (usage unique) et retourne le chemin canonique.
/// `Ok` ssi le jeton correspond au dernier émis pour ce Projet ; tout
/// échec laisse le disque intact (le jeton n'est brûlé qu'en cas de match).
pub fn consume_delete_token(reg: &Registry, path: &str, token: &str) -> Result<String, String> {
    let canonical = assert_project_member(path, reg)?;
    let key = canonical.to_string_lossy().into_owned();
    let mut guard = delete_tokens().lock().expect("jetons suppression");
    match guard.get(&key) {
        Some(expected) if expected == token => {
            guard.remove(&key);
            Ok(key)
        }
        _ => Err(
            "jeton de suppression invalide ou déjà utilisé : redemandez request_delete_token".into(),
        ),
    }
}

/// Cœur testable de `forget_project` (lib.rs délègue) : canonicalise, retire
/// du Registre, persiste — sans jamais toucher au contenu disque.
pub fn forget_project_in(cache_dir: &Path, path: &str) -> Result<String, String> {
    let canonical = canonical_project_path(path)?;
    let key = canonical.to_string_lossy().into_owned();
    let mut reg = load_registry_file(cache_dir);
    forget_registry(&mut reg, &key);
    save_registry_file(cache_dir, &reg)?;
    Ok(key)
}

/// Cœur testable de `delete_project` (lib.rs délègue) : appartenance +
/// jeton usage unique, puis suppression disque + sortie Registre.
pub fn delete_project_in(cache_dir: &Path, path: &str, token: &str) -> Result<String, String> {
    let mut reg = load_registry_file(cache_dir);
    let key = consume_delete_token(&reg, path, token)?;
    let dir = PathBuf::from(&key);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("suppression dossier : {e}"))?;
    }
    forget_registry(&mut reg, &key);
    save_registry_file(cache_dir, &reg)?;
    Ok(key)
}

pub fn parse_registry(text: &str) -> Result<Registry, String> {
    if text.trim().is_empty() {
        return Ok(Registry::default());
    }
    serde_json::from_str(text).map_err(|e| format!("registre illisible : {e}"))
}

/// Dossier parent complet d'un chemin Projet ("" si racine).
/// Sert l'Accueil (homonymes distingués par leur parent).
pub fn parent_of_project_path(path: &str) -> String {
    let p = Path::new(path);
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            parent.to_string_lossy().into_owned()
        }
        _ => String::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciled {
    /// Chemins du Registre dont le dossier est introuvable (orphelins).
    pub orphans: Vec<String>,
    /// Vrai si `last_opened` a été réinitialisé (pointait un orphelin).
    pub current_reset: bool,
}

/// Réconciliation boot (ticket #38) : existence vérifiée, orphelin explicite
/// (conservé — l'Oubli/Relink est un geste explicite), `last_opened`
/// réinitialisé sur le premier Projet existant (sinon `None`).
pub fn reconcile_registry(reg: &mut Registry) -> Reconciled {
    let orphans: Vec<String> = reg
        .projects
        .iter()
        .filter(|e| !Path::new(&e.path).exists())
        .map(|e| e.path.clone())
        .collect();
    let mut current_reset = false;
    if let Some(last) = reg.last_opened.clone() {
        let missing = !reg.projects.iter().any(|e| e.path == last);
        let orphaned = orphans.iter().any(|o| *o == last);
        if missing || orphaned {
            reg.last_opened = reg
                .projects
                .iter()
                .find(|e| !orphans.iter().any(|o| *o == e.path))
                .map(|e| e.path.clone());
            current_reset = true;
        }
    }
    Reconciled {
        orphans,
        current_reset,
    }
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

/// Sauvegarde le Registre (crée les parents). Atomique (tmp+rename+sync) :
/// écrivain unique côté backend (cf. `crate::boot::atomic_write`).
pub fn save_registry_file(cache_dir: &Path, reg: &Registry) -> Result<(), String> {
    let file = registry_file(cache_dir);
    let text = serialize_registry(reg)?;
    crate::boot::atomic_write(&file, text.as_bytes())
        .map_err(|e| format!("écriture registre : {e}"))?;
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
pub fn clear_delete_tokens_for_tests() {
    delete_tokens().lock().expect("jetons suppression").clear();
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

    // --- Ticket #38 : normalisation canonique unique + écriture atomique ----

    #[test]
    fn canonical_sans_slash_final_et_refuse_traversal() {
        assert_eq!(
            canonical_project_path("/tmp/projet-a/").unwrap(),
            PathBuf::from("/tmp/projet-a")
        );
        assert_eq!(
            canonical_project_path("/tmp/projet-a").unwrap(),
            PathBuf::from("/tmp/projet-a")
        );
        assert_eq!(canonical_project_path("/").unwrap(), PathBuf::from("/"));
        assert!(canonical_project_path("").is_err());
        assert!(canonical_project_path("relatif/x").is_err());
        // `..` refusé même quand la normalisation le résoudrait (Confinement).
        assert!(canonical_project_path("/tmp/../etc").is_err());
        assert!(canonical_project_path("/tmp/a/../b").is_err());
    }

    #[test]
    fn canonical_resout_symlink_si_existe() {
        let base = std::env::temp_dir().join(format!("nia-canon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let real = base.join("reel");
        std::fs::create_dir_all(&real).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = base.join("lien");
            symlink(&real, &link).unwrap();
            assert_eq!(
                canonical_project_path(link.to_str().unwrap()).unwrap(),
                canonical_project_path(real.to_str().unwrap()).unwrap()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn registre_sauvegarde_atomique_roundtrip_sans_tmp() {
        let base = std::env::temp_dir().join(format!("nia-reg-atom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mut reg = Registry::default();
        upsert_registry(&mut reg, "/p/a", "2026-01-01T00:00:00Z");
        save_registry_file(&base, &reg).expect("sauvegarde atomique");
        assert_eq!(load_registry_file(&base), reg);
        let leftovers: Vec<_> = std::fs::read_dir(base.join("niatscircuit"))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "tmp résiduels : {leftovers:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn registre_crash_tmp_abandonne_cible_intacte() {
        let base = std::env::temp_dir().join(format!("nia-reg-crash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mut reg = Registry::default();
        upsert_registry(&mut reg, "/p/a", "2026-01-01T00:00:00Z");
        save_registry_file(&base, &reg).expect("sauvegarde initiale");
        // Simule un kill en pleine écriture : tmp écrit mais jamais renommé.
        let file = registry_file(&base);
        std::fs::write(
            file.with_extension("json.12345.tmp"),
            r#"{"projects": [{BROKEN"#,
        )
        .unwrap();
        assert_eq!(load_registry_file(&base), reg, "cible intacte malgré tmp");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn registre_ecritures_concurrentes_toujours_valides() {
        let base = std::env::temp_dir().join(format!("nia-reg-conc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::thread::scope(|s| {
            for t in 0..8 {
                let base = &base;
                s.spawn(move || {
                    for i in 0..25 {
                        let mut reg = load_registry_file(base);
                        upsert_registry(
                            &mut reg,
                            &format!("/p/t{t}/{i}"),
                            "2026-01-01T00:00:00Z",
                        );
                        save_registry_file(base, &reg).expect("écriture concurrente");
                        // Relecture immédiate : jamais de JSON tronqué.
                        let _ = load_registry_file(base);
                    }
                });
            }
        });
        let reg = load_registry_file(&base);
        assert!(!reg.projects.is_empty());
        assert!(reg.last_opened.is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- Ticket #38 : circuit.json versionné ----------------------------

    fn circuit_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nia-circuit-{}-{name}", std::process::id()))
    }

    #[test]
    fn circuit_absent_recree_vide_versionne() {
        let dir = circuit_tmp("absent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(ensure_circuit_file(&dir).unwrap(), CircuitInit::Created);
        assert_eq!(read_circuit_file(&dir).unwrap(), Vec::<serde_json::Value>::new());
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("circuit.json")).unwrap())
                .unwrap();
        assert_eq!(raw.get("version").and_then(|v| v.as_u64()), Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn circuit_existant_valide_relu() {
        let dir = circuit_tmp("valide");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("circuit.json"), serialize_circuit(&[]).unwrap()).unwrap();
        assert_eq!(ensure_circuit_file(&dir).unwrap(), CircuitInit::Exists);
        assert_eq!(read_circuit_file(&dir).unwrap(), Vec::<serde_json::Value>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn circuit_legacy_tableau_nu_migre_donnees_preservees() {
        let dir = circuit_tmp("legacy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("circuit.json"), r#"[{"type":"source"}]"#).unwrap();
        assert_eq!(ensure_circuit_file(&dir).unwrap(), CircuitInit::Migrated);
        let back = read_circuit_file(&dir).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].get("type").and_then(|v| v.as_str()), Some("source"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn circuit_corrompu_erreur_visible_fichier_preserve() {
        let dir = circuit_tmp("corrompu");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("circuit.json"), "{ pas du json").unwrap();
        let err = ensure_circuit_file(&dir).expect_err("corrompu = erreur");
        assert!(err.contains("circuit.json"), "message visible : {err}");
        assert!(read_circuit_file(&dir).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("circuit.json")).unwrap(),
            "{ pas du json",
            "jamais écrasé silencieusement"
        );
        // Version future / enveloppe invalide : même refus visible.
        std::fs::write(dir.join("circuit.json"), r#"{"version":99,"circuitJson":[]}"#).unwrap();
        assert!(ensure_circuit_file(&dir).is_err());
        std::fs::write(dir.join("circuit.json"), r#"{"version":1}"#).unwrap();
        assert!(read_circuit_file(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn layout_cree_circuit_versionne() {
        let dir = circuit_tmp("layout");
        let _ = std::fs::remove_dir_all(&dir);
        ensure_project_layout(&dir, "vide").expect("layout");
        assert_eq!(read_circuit_file(&dir).unwrap(), Vec::<serde_json::Value>::new());
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("circuit.json")).unwrap())
                .unwrap();
        assert_eq!(raw.get("version").and_then(|v| v.as_u64()), Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Ticket #38 : réconciliation boot (orphelin explicite) ----------

    #[test]
    fn reconcilie_orphelin_conserve_signale() {
        let base = std::env::temp_dir().join(format!("nia-recon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let gone = base.join("supprime");
        let mut reg = Registry::default();
        upsert_registry(&mut reg, gone.to_str().unwrap(), "2026-01-01T00:00:00Z");
        let out = reconcile_registry(&mut reg);
        assert_eq!(out.orphans, vec![gone.to_string_lossy().into_owned()]);
        assert_eq!(reg.projects.len(), 1, "jamais supprimé silencieusement");
        assert!(reg.last_opened.is_none(), "current réinitialisé");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn reconcilie_lastopened_sur_premier_existant() {
        let base = std::env::temp_dir().join(format!("nia-recon2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let gone = base.join("gone");
        let alive = base.join("alive");
        std::fs::create_dir_all(&alive).unwrap();
        let mut reg = Registry::default();
        upsert_registry(&mut reg, gone.to_str().unwrap(), "2026-01-01T00:00:00Z");
        upsert_registry(&mut reg, alive.to_str().unwrap(), "2026-01-02T00:00:00Z");
        reg.last_opened = Some(gone.to_string_lossy().into_owned());
        let out = reconcile_registry(&mut reg);
        assert!(out.current_reset, "lastOpened orphelin → réinitialisé");
        assert_eq!(reg.last_opened.as_deref(), Some(alive.to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn reconcilie_registre_sain_inchange() {
        let base = std::env::temp_dir().join(format!("nia-recon3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let alive = base.join("ok");
        std::fs::create_dir_all(&alive).unwrap();
        let mut reg = Registry::default();
        upsert_registry(&mut reg, alive.to_str().unwrap(), "2026-01-01T00:00:00Z");
        let snapshot = reg.clone();
        let out = reconcile_registry(&mut reg);
        assert!(out.orphans.is_empty());
        assert!(!out.current_reset);
        assert_eq!(reg, snapshot);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parent_distingue_homonymes() {
        assert_eq!(parent_of_project_path("/a/parent-a/doublon"), "/a/parent-a");
        assert_eq!(parent_of_project_path("/doublon"), "/");
        assert_eq!(parent_of_project_path("/"), "");
    }

    // --- Ticket #43 : lecture main.tsx + hash (relecture conditionnelle) ----

    #[test]
    fn lit_main_avec_hash_coherent() {
        let base = std::env::temp_dir().join(format!("nia-readmain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        ensure_project_layout(&base, "vide").expect("layout");
        std::fs::write(base.join("main.tsx"), "code-marqueur").unwrap();
        let got = read_main_file(&base).expect("lit main");
        assert_eq!(got.code, "code-marqueur");
        assert_eq!(got.path, base.join("main.tsx").to_string_lossy());
        assert_eq!(got.hash, crate::watch::hash_main_content(b"code-marqueur"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn lit_main_absent_erreur_explicite() {
        let base = std::env::temp_dir().join(format!("nia-readmain-ko-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let err = read_main_file(&base).expect_err("sans main.tsx → erreur");
        assert!(err.contains("lecture main.tsx"), "erreur explicite : {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- Ticket #45 : écriture main.tsx (coller du TSX, gabarit démo) -------

    #[test]
    fn ecrit_main_puis_relire_hash_coherent() {
        let base = std::env::temp_dir().join(format!("nia-writemain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let got = write_main_file(&base, "code-marqueur").expect("écrit main");
        assert_eq!(got.code, "code-marqueur");
        assert_eq!(got.path, base.join("main.tsx").to_string_lossy());
        assert_eq!(got.hash, crate::watch::hash_main_content(b"code-marqueur"));
        // Relecture disque identique (source de vérité).
        let relu = read_main_file(&base).expect("relit main");
        assert_eq!(relu.hash, got.hash);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ecrit_main_ecrase_et_rearme_le_hash() {
        let base =
            std::env::temp_dir().join(format!("nia-writemain-2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let premier = write_main_file(&base, "v1").expect("écrit v1");
        let second = write_main_file(&base, "v2llllllllll").expect("écrit v2");
        assert_ne!(premier.hash, second.hash, "le hash suit le contenu");
        assert_eq!(read_main_file(&base).unwrap().code, "v2llllllllll");
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- Ticket #42 : Confinement (appartenance Registre après canonicalisation) ---

    fn confinement_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nia-confine-{}-{name}", std::process::id()))
    }

    #[test]
    fn membre_reconnu_apres_canonicalisation_slash_final() {
        let dir = confinement_tmp("membre");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut reg = Registry::default();
        upsert_registry(&mut reg, dir.to_str().unwrap(), "2026-01-01T00:00:00Z");
        let avec_slash = format!("{}/", dir.to_string_lossy());
        assert!(is_project_member(&avec_slash, &reg));
        assert_eq!(
            assert_project_member(&avec_slash, &reg).unwrap(),
            canonical_project_path(dir.to_str().unwrap()).unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hors_perimetre_erreur_explicite() {
        let dir = confinement_tmp("hors");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let reg = Registry::default();
        assert!(!is_project_member(dir.to_str().unwrap(), &reg));
        let err = assert_project_member(dir.to_str().unwrap(), &reg).expect_err("hors périmètre");
        assert!(err.contains("hors périmètre"), "explicite : {err}");
        assert!(err.contains("Confinement"), "terme glossaire : {err}");
        assert!(err.contains("Registre"), "recours : {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn traversal_refuse_avant_appartenance() {
        let reg = Registry::default();
        assert!(assert_project_member("/tmp/../etc", &reg).is_err());
        assert!(assert_project_member("relatif/x", &reg).is_err());
    }

    #[test]
    fn retrait_registre_aussitot_hors_perimetre() {
        let dir = confinement_tmp("retrait");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut reg = Registry::default();
        upsert_registry(&mut reg, dir.to_str().unwrap(), "2026-01-01T00:00:00Z");
        assert!(is_project_member(dir.to_str().unwrap(), &reg));
        reg.projects.clear();
        reg.last_opened = None;
        assert!(!is_project_member(dir.to_str().unwrap(), &reg));
        assert!(assert_project_member(dir.to_str().unwrap(), &reg).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Ticket #42 : garde suppression backend à jeton usage unique ------

    fn delete_tmp(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("nia-del-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        (base.join("cache"), base.join("projet"))
    }

    fn registered_project(cache: &Path, dir: &Path) -> Registry {
        let mut reg = Registry::default();
        upsert_registry(&mut reg, dir.to_str().unwrap(), "2026-01-01T00:00:00Z");
        save_registry_file(cache, &reg).expect("registre test");
        reg
    }

    #[test]
    fn suppression_exige_jeton_usage_unique() {
        clear_delete_tokens_for_tests();
        let (cache, dir) = delete_tmp("jeton");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.tsx"), "code").unwrap();
        let reg = registered_project(&cache, &dir);
        let path = dir.to_str().unwrap();
        // Sans jeton préalable : refusé, disque intact.
        assert!(delete_project_in(&cache, path, "jeton-inventé").is_err());
        assert!(dir.join("main.tsx").exists(), "disque intact après refus");
        // Jeton émis puis consommé : suppression effective.
        let token = request_delete_token(&reg, path).expect("jeton émis");
        assert!(!token.is_empty());
        delete_project_in(&cache, path, &token).expect("suppression autorisée");
        assert!(!dir.exists(), "dossier supprimé");
        assert!(!load_registry_file(&cache).projects.iter().any(|e| e.path == path));
        // Rejeu du même jeton : refusé (usage unique — le Projet sorti du
        // Registre est en outre hors périmètre).
        let rej = delete_project_in(&cache, path, &token).expect_err("rejeu refusé");
        assert!(
            rej.contains("déjà utilisé") || rej.contains("invalide") || rej.contains("hors périmètre"),
            "{rej}"
        );
        // Preuve de consommation (pas seulement du retrait Registre) : le
        // Projet ré-enregistré refuse toujours l'ancien jeton…
        std::fs::create_dir_all(&dir).unwrap();
        let reg = registered_project(&cache, &dir);
        let rej = delete_project_in(&cache, path, &token).expect_err("ancien jeton brûlé");
        assert!(rej.contains("déjà utilisé") || rej.contains("invalide"), "{rej}");
        assert!(dir.exists(), "disque intact après rejeu");
        // …mais un jeton frais fonctionne à nouveau.
        let fresh = request_delete_token(&reg, path).expect("jeton frais");
        delete_project_in(&cache, path, &fresh).expect("nouveau jeton valide");
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(cache.parent().unwrap());
    }

    #[test]
    fn suppression_hors_perimetre_refusee_disque_intact() {
        clear_delete_tokens_for_tests();
        let (cache, dir) = delete_tmp("hors");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.tsx"), "code").unwrap();
        let reg = Registry::default();
        save_registry_file(&cache, &reg).expect("registre vide");
        // Émission refusée hors périmètre…
        let err = request_delete_token(&reg, dir.to_str().unwrap()).expect_err("hors périmètre");
        assert!(err.contains("hors périmètre"), "{err}");
        // …et consommation directe impossible (pas de jeton à deviner).
        let err = delete_project_in(&cache, dir.to_str().unwrap(), "deviné").expect_err("refusé");
        assert!(err.contains("hors périmètre") || err.contains("invalide"), "{err}");
        assert!(dir.join("main.tsx").exists(), "disque intact");
        let _ = std::fs::remove_dir_all(cache.parent().unwrap());
    }

    #[test]
    fn oubli_ne_touche_jamais_au_disque_pas_de_corbeille() {
        let (cache, dir) = delete_tmp("oubli");
        std::fs::create_dir_all(dir.join("previews")).unwrap();
        std::fs::write(dir.join("main.tsx"), "code").unwrap();
        std::fs::write(dir.join("previews").join("pcb_2d.png"), "png").unwrap();
        registered_project(&cache, &dir);
        let base = cache.parent().unwrap().to_path_buf();
        forget_project_in(&cache, dir.to_str().unwrap()).expect("oubli");
        // Disque intact : fichiers présents, aucune corbeille créée.
        assert!(dir.join("main.tsx").exists());
        assert!(dir.join("previews").join("pcb_2d.png").exists());
        let trash: Vec<_> = std::fs::read_dir(&base)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| {
                let l = n.to_lowercase();
                l.contains("trash") || l.contains("corbeille")
            })
            .collect();
        assert!(trash.is_empty(), "pas de corbeille en V1 : {trash:?}");
        // Registre nettoyé.
        assert!(load_registry_file(&cache).projects.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }
}
