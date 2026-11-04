//! Watcher `main.tsx` du Projet ouvert (ticket #43, spec #37 § Implementation).
//!
//! - Un seul watch actif (ré-armé à chaque ouverture/création, retiré à la
//!   fermeture), debounce, filtre sur ce seul fichier : le dossier Projet est
//!   surveillé en non-récursif (l'écriture atomique tmp+rename remplace
//!   l'inode — surveiller le fichier direct perdrait le watch) et seuls les
//!   événements du `main.tsx` déclenchent.
//! - Payload d'événement : `{ path, hash }` (hash sha256 hex du contenu) ;
//!   la WebView décide seule de relire (relecture conditionnelle).
//! - Transport MCP et CSP inchangés : l'événement part par le bus Tauri
//!   (`project-main-changed`), le polling long reste un repli dégradé.

use std::path::Path;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use sha2::{Digest, Sha256};

/// Nom d'événement Tauri consommé par la WebView (`listen`).
pub const MAIN_CHANGED_EVENT: &str = "project-main-changed";

/// Nom d'événement du changement de Projet ouvert (ticket #57, spec #55) :
/// émis par le watcher disque Rust quand le Projet canonique change
/// (`project_open` / `project_close` MCP), distinct de
/// `project-main-changed` (contenu `main.tsx` du Projet courant).
pub const OPEN_CHANGED_EVENT: &str = "project-open-changed";

/// Payload `{ projectPath: string|null }` : Projet ouvert canonique ou
/// `null` si Accueil (fermeture, dossier supprimé).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OpenChangedPayload {
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
}

/// Construit le payload depuis le Projet canonique (`None` = Accueil).
pub fn open_changed_payload(project: Option<&str>) -> OpenChangedPayload {
    OpenChangedPayload {
        project_path: project.map(|s| s.to_string()),
    }
}

/// Debounce du watcher (rafale d'écritures agent → un seul événement).
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Nom du seul fichier surveillé (filtre dans le dossier Projet).
pub const MAIN_FILE: &str = "main.tsx";

/// Payload `{ path, hash }` : chemin Projet canonique + hash du contenu.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MainChangedPayload {
    pub path: String,
    pub hash: String,
}

/// Hash stable du contenu `main.tsx` (sha256 hex, 64 car.) : même règle que
/// `hashMainCode` côté sidecar (`pcb-mcp/src/project.ts`).
pub fn hash_main_content(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

/// Construit le payload depuis le dossier Projet canonique + code disque.
/// `path` = le `main.tsx` surveillé (ce qui a changé), pas le dossier.
pub fn main_changed_payload(project_dir: &Path, code: &str) -> MainChangedPayload {
    MainChangedPayload {
        path: project_dir.join(MAIN_FILE).to_string_lossy().to_string(),
        hash: hash_main_content(code.as_bytes()),
    }
}

/// Surveille le `main.tsx` du Projet : appelle `on_change` (debouncé) avec
/// `{ path, hash }` à chaque modification. Le garde retourné arrête le watch
/// à sa destruction (`stop()` explicite aussi).
pub struct ProjectMainWatch {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl ProjectMainWatch {
    /// Arrête le watch (la destruction fait de même).
    pub fn stop(self) {}
}

/// Démarre le watch sur le dossier Projet (doit exister). Erreur explicite
/// sinon — jamais de watch silencieux sur un dossier fantôme.
pub fn watch_project_main<F>(
    project_dir: &Path,
    debounce: Duration,
    on_change: F,
) -> Result<ProjectMainWatch, String>
where
    F: Fn(MainChangedPayload) + Send + 'static,
{
    if !project_dir.is_dir() {
        return Err(format!(
            "watch impossible : dossier introuvable ({})",
            project_dir.display()
        ));
    }
    // Canonicalise : les chemins d'événements notify sont comparés à l'exact.
    let dir = std::fs::canonicalize(project_dir)
        .map_err(|e| format!("watch canonicalize {} : {e}", project_dir.display()))?;
    let main = dir.join(MAIN_FILE);
    let dir_label = dir.to_string_lossy().to_string();
    // Dernier hash émis : la relecture du handler (et tout accès) déclenche
    // elle-même un événement notify — on n'émet que si le CONTENU a changé.
    // Sans ce garde, le watcher bouclerait sur ses propres lectures.
    let mut last_hash: Option<String> = None;
    let mut debouncer = new_debouncer(debounce, move |res: DebounceEventResult| {
        let events = match res {
            Ok(events) => events,
            Err(e) => {
                eprintln!("[watch] erreur debouncer ({dir_label}) : {e:?}");
                return;
            }
        };
        // Filtre sur ce seul fichier : tmp atomiques, circuit.json, previews…
        let touched = events.iter().any(|e| e.path == main);
        if !touched {
            return;
        }
        match std::fs::read(&main) {
            Ok(bytes) => {
                let hash = hash_main_content(&bytes);
                if last_hash.as_deref() == Some(hash.as_str()) {
                    return;
                }
                last_hash = Some(hash.clone());
                on_change(MainChangedPayload {
                    path: main.to_string_lossy().to_string(),
                    hash,
                });
            }
            Err(e) => {
                // Lecture KO (suppression entre-temps ?) : pas d'événement
                // mensonger ; le repli polling / read_project_main remontera
                // l'erreur explicite côté WebView.
                eprintln!("[watch] relecture {} KO : {e}", main.display());
            }
        }
    })
    .map_err(|e| format!("watch démarrage {} : {e:?}", dir.display()))?;
    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {} : {e:?}", dir.display()))?;
    Ok(ProjectMainWatch {
        _debouncer: debouncer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    fn tmp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nia-watch-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("horloge")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("tmp projet");
        std::fs::write(dir.join("main.tsx"), "export default () => (<board />)\n")
            .expect("main initial");
        dir
    }

    #[test]
    fn hash_main_content_vecteur_sha256() {
        assert_eq!(
            hash_main_content(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hash_main_content(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_ne!(hash_main_content(b"abc"), hash_main_content(b"abd"));
    }

    #[test]
    fn payload_serialise_path_hash() {
        let dir = tmp_project("payload");
        let payload = main_changed_payload(&dir, "code");
        let json = serde_json::to_string(&payload).expect("sérialisable");
        assert!(json.contains("\"path\""), "payload : {json}");
        assert!(json.contains("\"hash\""), "payload : {json}");
        assert_eq!(payload.hash, hash_main_content(b"code"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watcher_coalesce_rafale_filtre_bruit_stop() {
        let dir = tmp_project("rafale");
        let main = dir.join("main.tsx");
        let (tx, rx) = mpsc::channel();
        let _watch = watch_project_main(&dir, Duration::from_millis(120), move |p| {
            let _ = tx.send(p);
        })
        .expect("watch démarre");
        // Rafale d'écritures + bruit sur un autre fichier.
        for i in 0..5 {
            std::fs::write(&main, format!("// v{i}\nexport default () => (<board />)\n"))
                .expect("écriture rafale");
        }
        std::fs::write(dir.join("circuit.json"), r#"{"version":1}"#).expect("bruit");
        // Un événement coalescé, avec le hash FINAL.
        let got = rx.recv_timeout(Duration::from_secs(5)).expect("événement main");
        assert!(got.path.ends_with("main.tsx"), "filtre main.tsx : {}", got.path);
        let final_code = std::fs::read_to_string(&main).expect("relit main final");
        assert_eq!(got.hash, hash_main_content(final_code.as_bytes()));
        // Pas d'événement pour le bruit, pas de doublon de rafale.
        assert!(
            rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "un seul événement par rafale, rien pour circuit.json"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watcher_refuse_dossier_absent() {
        let missing = std::env::temp_dir().join(format!(
            "nia-watch-absent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("horloge")
                .as_nanos()
        ));
        let (tx, _rx) = mpsc::channel();
        let res = watch_project_main(&missing, Duration::from_millis(50), move |p| {
            let _ = tx.send(p);
        });
        assert!(res.is_err(), "dossier absent → erreur explicite");
    }

    #[test]
    fn watcher_stop_coupe_les_evenements() {
        let dir = tmp_project("stop");
        let main = dir.join("main.tsx");
        let (tx, rx) = mpsc::channel();
        let watch = watch_project_main(&dir, Duration::from_millis(80), move |p| {
            let _ = tx.send(p);
        })
        .expect("watch démarre");
        watch.stop();
        std::fs::write(&main, "// après stop\nexport default () => (<board />)\n")
            .expect("écriture après stop");
        assert!(
            rx.recv_timeout(Duration::from_millis(500)).is_err(),
            "aucun événement après stop"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Ticket #57 (T3-sync) : nouvel event de Projet ouvert -------------
    // RED : échoue tant que `OPEN_CHANGED_EVENT` / `OpenChangedPayload`
    // n'existent pas (couture event, distincte de `project-main-changed`).

    #[test]
    fn t3_open_event_distinct_du_main_changed() {
        assert_eq!(OPEN_CHANGED_EVENT, "project-open-changed");
        assert_ne!(OPEN_CHANGED_EVENT, MAIN_CHANGED_EVENT);
    }

    #[test]
    fn t3_open_payload_serialise_projectpath_ou_null() {
        let open = open_changed_payload(Some("/tmp/projet-b"));
        let json = serde_json::to_string(&open).expect("sérialisable");
        assert!(json.contains("\"projectPath\""), "clé contrat : {json}");
        assert!(json.contains("/tmp/projet-b"), "chemin porté : {json}");
        let close = open_changed_payload(None);
        let json = serde_json::to_string(&close).expect("sérialisable");
        let back: serde_json::Value = serde_json::from_str(&json).expect("re-lit");
        assert_eq!(back.get("projectPath"), Some(&serde_json::Value::Null));
    }
}
