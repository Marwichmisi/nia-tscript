//! BYOK LLM Meta (ticket #58 / T4) — clé chiffrée, commande dédiée, budgets.
//!
//! Seam B (testée ici) : cœur sans GUI — masque, allowlist deny-prioritaire,
//! garde `NO_PROJECT_OPEN`, budgets/backoff/hard-limit, logs assainis,
//! vault chiffré au repos (AES-256-GCM, dérivation côté Rust), cycle
//! enregistrer → tester → remplacer → supprimer. Le réseau réel vit derrière
//! le trait `LlmTransport` (seule couture mockée : le système externe) ;
//! la prod l'implémente avec `reqwest`, les tests avec `FakeTransport`.
//! Le frontend ne voit jamais que `LlmStatus` (masque + statut).
//!
//! Écart documenté (étude §3) : vault AES-256-GCM maison plutôt que plugin
//! Stronghold — mêmes garanties G2 (chiffré au repos, jamais en clair hors
//! backend, dérivation côté Rust, 0600), sans mot de passe maître à gérer
//! (Stronghold exigerait de stocker son propre mot de passe de la même
//! façon) et testable sans `AppHandle`. Migration Stronghold possible sans
//! changer les commandes ni le frontend.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

// --- Constantes -------------------------------------------------------------

/// Base du fournisseur : Meta Model API, OpenAI-compatible (Chat Completions
/// + Responses, tool calling des deux côtés).
pub const META_API_BASE: &str = "https://api.meta.ai/v1";
/// Appel test au coût nul (vérification de clé).
pub const MODELS_PATH: &str = "/models";
pub const CHAT_PATH: &str = "/chat/completions";
pub const RESPONSES_PATH: &str = "/responses";
/// Repli hors-ligne : la liste réelle vient de `GET /v1/models`.
pub const DEFAULT_MODEL: &str = "default";
/// Plafond payload (≈ quelques dizaines de Ko, cf. étude §5).
pub const MAX_PAYLOAD_CHARS: usize = 24_000;
/// `max_tokens` par appel : défaut + hard limit.
pub const MAX_TOKENS_DEFAULT: u32 = 2_000;
pub const MAX_TOKENS_HARD: u32 = 8_000;
/// Coupe-circuit session (Denial-of-Wallet, cf. étude §8 / G7).
pub const SESSION_TOKEN_CAP: u64 = 100_000;
/// Tentatives totales par appel (1 essai + retries 429/5xx).
pub const MAX_ATTEMPTS: u32 = 3;
/// Backoff : base 1 s, doublement, plafond 30 s ; `Retry-After` honoré.
pub const BACKOFF_BASE_MS: u64 = 1_000;
pub const BACKOFF_CAP_MS: u64 = 30_000;
/// Nom du fichier vault (même cache de base que Registre/lockfile).
pub const VAULT_REL: &str = "niatscircuit/llm-vault.json";

/// Garde G3 : aucun appel LLM sans Projet ouvert (périmètre réseau suit le
/// périmètre disque, cf. ADR 0001 + étude §9).
pub const NO_PROJECT_OPEN_MSG: &str =
    "NO_PROJECT_OPEN : ouvre un Projet pour activer l'Agent intégré — aucun appel LLM sans Projet ouvert";

// --- Statut (seule chose visible du frontend) -------------------------------

/// Statut exposé au frontend : masque + métadonnées, JAMAIS la clé.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    pub configured: bool,
    /// Masque `••••1234` (4 derniers) ou `••••` si trop courte.
    pub mask: String,
    /// RFC3339 de la dernière vérification réussie.
    pub verified_at: Option<String>,
    /// Modèle par défaut (liste réelle via `GET /v1/models`, repli `default`).
    pub model: String,
    /// Télémétrie d'usage : opt-in explicite, défaut `false` (G8).
    pub telemetry_opt_in: bool,
    /// Jetons consommés cette session (budget visible).
    pub session_tokens: u64,
}

fn unconfigured_status() -> LlmStatus {
    LlmStatus {
        configured: false,
        mask: "••••".to_string(),
        verified_at: None,
        model: DEFAULT_MODEL.to_string(),
        telemetry_opt_in: false,
        session_tokens: 0,
    }
}

// --- Helpers purs (seam A) ----------------------------------------------------

/// Masque affiché au frontend : `••••` + 4 derniers caractères.
pub fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() >= 4 {
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("••••{tail}")
    } else {
        "••••".to_string()
    }
}

/// Vrai ssi l'URL est appelable par la commande dédiée. Deny prioritaire :
/// tout ce qui n'est pas explicitement allow est refusé (étude §4 / G4).
/// Allow : `https://api.meta.ai/v1/*` + loopback local (`localhost`,
/// `127.0.0.1`, `[::1]` en `http`, mode local §7). Rien d'autre.
pub fn is_url_allowed(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://api.meta.ai/v1/") {
        return !rest.is_empty();
    }
    // Mode local (§7, matrice V1) : http loopback uniquement, port numérique exigé
    // (refuse `localhost.evil.com` et tout `https` local).
    // Justification : le loopback n'est pas routable hors machine (127.0.0.1/::1 =
    // l'hôte lui-même) — l'allowlist l'autorise pour le mode local Ollama
    // (serveur de modèles sur la machine, ex `http://localhost:11434`), sans
    // ouvrir aucun accès réseau externe. Le port numérique exigé bloque les
    // sosies (`localhost.evil.com`) et tout le reste reste refusé (deny prioritaire).
    for prefix in ["http://localhost:", "http://127.0.0.1:", "http://[::1]:"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            match rest.find('/') {
                Some(slash) => {
                    return slash > 0 && rest[..slash].chars().all(|c| c.is_ascii_digit());
                }
                None => return false,
            }
        }
    }
    false
}

fn join_allowed(base: &str, path: &str) -> Result<String, String> {
    let base = base.trim_end_matches('/');
    let url = format!("{base}{path}");
    if is_url_allowed(&url) {
        Ok(url)
    } else {
        Err(format!("hôte non autorisé (allowlist) : {base}"))
    }
}

/// URL `GET /v1/models` (coût nul), vérifiée allowlist.
pub fn models_url(base: &str) -> Result<String, String> {
    join_allowed(base, MODELS_PATH)
}

/// URL d'appel agent (`chat` = Chat Completions, `responses` = Responses),
/// vérifiée allowlist.
pub fn chat_url(base: &str, mode: &str) -> Result<String, String> {
    match mode {
        "chat" => join_allowed(base, CHAT_PATH),
        "responses" => join_allowed(base, RESPONSES_PATH),
        other => Err(format!("mode inconnu « {other} » (attendus : chat, responses)")),
    }
}

/// Garde G3 : exige un Projet ouvert (chaîne non vide après trim).
pub fn require_project_open(project: Option<&str>) -> Result<String, String> {
    match project.map(str::trim) {
        Some(p) if !p.is_empty() => Ok(p.to_string()),
        _ => Err(NO_PROJECT_OPEN_MSG.to_string()),
    }
}

/// `true` ssi un retry est autorisé pour ce statut : 429 + 5xx uniquement.
/// Jamais sur 400/401/402/403/404 (inutile + coûteux).
pub fn should_retry(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

/// Délai avant tentative suivante (ms) : `Retry-After` honoré (plafonné),
/// sinon base 1 s doublée par tentative, plafond 30 s. `attempt` = 0-based.
/// (Jitter ajouté à l'appel, hors pur pour testabilité.)
pub fn backoff_delay_ms(attempt: u32, retry_after_secs: Option<u64>) -> u64 {
    if let Some(s) = retry_after_secs {
        return s.saturating_mul(1_000).min(BACKOFF_CAP_MS);
    }
    BACKOFF_BASE_MS
        .saturating_mul(1u64 << attempt.min(16))
        .min(BACKOFF_CAP_MS)
}

/// Parse un en-tête `Retry-After` (secondes delta uniquement).
pub fn parse_retry_after(header: Option<&str>) -> Option<u64> {
    header?.trim().parse::<u64>().ok()
}

/// Coupe-circuit : refuse quand le cumul session + estimation dépasse le cap.
pub fn check_budget(session_tokens: u64, estimated: u64) -> Result<(), String> {
    if session_tokens.saturating_add(estimated) > SESSION_TOKEN_CAP {
        return Err(format!(
            "Budget session épuisé (hard limit {SESSION_TOKEN_CAP} jetons) — nouvelle conversation ou attends la réinitialisation"
        ));
    }
    Ok(())
}

/// Refuse les payloads au-delà du plafond (étude §5).
pub fn check_payload_size(chars: usize) -> Result<(), String> {
    if chars > MAX_PAYLOAD_CHARS {
        return Err(format!(
            "Prompt trop volumineux ({chars} > {MAX_PAYLOAD_CHARS} caractères) — réduis la sélection"
        ));
    }
    Ok(())
}

/// Caviarde pour les logs (G8) : secrets connus + schémas `Bearer <jeton>`
/// remplacés par `[CAVIARDÉ]`. Zéro secret, zéro prompt intégral dans les logs.
pub fn sanitize_for_log(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for s in secrets {
        if !s.is_empty() {
            out = out.replace(s, "[CAVIARDÉ]");
        }
    }
    // `Bearer <jeton>` résiduel (clé non listée) : caviarde jusqu'au
    // prochain délimiteur.
    let mut res = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(i) = rest.find("Bearer ") {
        let cut = i + "Bearer ".len();
        res.push_str(&rest[..cut]);
        res.push_str("[CAVIARDÉ]");
        let tail = &rest[cut..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';'))
            .unwrap_or(tail.len());
        rest = &tail[end..];
    }
    res.push_str(rest);
    res
}

/// Minimisation (étude §5) : chemins absolus du Projet relativisés en
/// `<Projet>/` avant tout envoi.
pub fn relativize_paths(text: &str, project_dir: &str) -> String {
    if project_dir.is_empty() {
        return text.to_string();
    }
    let full = text.replace(project_dir, "<Projet>");
    let trimmed = project_dir.trim_end_matches('/');
    if trimmed != project_dir {
        full.replace(trimmed, "<Projet>")
    } else {
        full
    }
}

/// Récapitulatif pré-envoi + opt-in (étude §5 / G5) : texte affiché et exigé
/// avant tout envoi au modèle.
pub fn summarize_for_consent(main_lines: usize, circuit_elements: usize) -> String {
    format!(
        "Ce prompt enverra main.tsx (≈ {main_lines} lignes) et {circuit_elements} éléments circuit-json. \
Chemins relativisés, previews/exports exclus. Envoi après opt-in — Annulable."
    )
}

/// Interprète la réponse de `GET /v1/models` : `Ok(ids)` si 200 (+ repli
/// liste vide si enveloppe inattendue mais 200 : le 200 prouve la clé),
/// `Err` français précis sinon (401 = invalide/révoquée, 429 = patienter,
/// 5xx = indisponible).
pub fn interpret_models_response(
    status: u16,
    retry_after_secs: Option<u64>,
    body: &str,
) -> Result<Vec<String>, String> {
    match status {
        200 => {
            let ids = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("data")?.as_array().cloned())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| e.get("id")?.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            Ok(ids)
        }
        401 | 403 => Err(format!(
            "Clé invalide ou révoquée ({status}) — vérifie la clé dans les Paramètres"
        )),
        429 => {
            let wait = retry_after_secs
                .unwrap_or_else(|| backoff_delay_ms(0, None) / 1_000);
            Err(format!(
                "Quota atteint (429) — patiente {wait} s puis réessaie"
            ))
        }
        500..=599 => Err(format!(
            "Fournisseur indisponible ({status}) — réessaie dans un instant"
        )),
        other => Err(format!(
            "Vérification refusée (HTTP {other}) — réessaie ou vérifie la clé dans les Paramètres"
        )),
    }
}

/// Message réseau (transport KO) : hors-ligne, aucun appel émis.
pub fn transport_error_msg() -> String {
    "Hors-ligne ou hôte injoignable — aucun appel émis, l'app reste utilisable".to_string()
}

// --- Vault chiffré (clé jamais en clair hors backend) --------------------------

/// Métadonnées persistées + enveloppe chiffrée. Le `mask` pré-calculé évite
/// de déchiffrer pour afficher le statut (frontend : jamais de clé).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct VaultFile {
    version: u32,
    salt_b64: String,
    nonce_b64: String,
    ciphertext_b64: String,
    mask: String,
    verified_at: String,
    model: String,
    telemetry_opt_in: bool,
    session_tokens: u64,
}

const VAULT_VERSION: u32 = 1;

/// Dérivation côté Rust : `SHA256("nia-llm-vault-v1" || machine || salt)`.
/// Liaison machine best-effort (`/etc/machine-id` + env) : le 0600 reste la
/// barrière d'accès, AES-GCM le chiffrement au repos.
fn vault_key_bytes(salt: &[u8]) -> [u8; 32] {
    use sha2::Digest as _;
    let mut h = sha2::Sha256::new();
    h.update(b"nia-llm-vault-v1");
    h.update(machine_binding());
    h.update(salt);
    h.finalize().into()
}

fn machine_binding() -> Vec<u8> {
    let mut v = Vec::new();
    #[cfg(target_os = "linux")]
    if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
        v.extend(id.trim().as_bytes());
        v.push(0);
    }
    for key in ["HOSTNAME", "COMPUTERNAME", "USERNAME", "USER"] {
        if let Ok(val) = std::env::var(key) {
            v.extend(val.as_bytes());
            v.push(0);
        }
    }
    v.extend(env!("CARGO_PKG_NAME").as_bytes());
    v
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| "vault illisible (encodage) — supprime et réenregistre la clé".to_string())
}

/// Fichier vault sous le cache de base (même dossier que Registre/lockfile).
pub fn vault_file(cache_dir: &Path) -> PathBuf {
    cache_dir.join(VAULT_REL)
}

fn read_vault(cache_dir: &Path) -> Result<VaultFile, String> {
    let path = vault_file(cache_dir);
    let text = std::fs::read_to_string(&path).map_err(|_| {
        "aucune clé configurée — colle ta clé dans les Paramètres".to_string()
    })?;
    let v: VaultFile = serde_json::from_str(&text)
        .map_err(|_| "vault corrompu (JSON illisible) — supprime et réenregistre la clé".to_string())?;
    if v.version != VAULT_VERSION {
        return Err(format!(
            "vault version {} non supportée (attendue : {}) — supprime et réenregistre la clé",
            v.version, VAULT_VERSION
        ));
    }
    Ok(v)
}

fn decrypt_key(v: &VaultFile) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let salt = unb64(&v.salt_b64)?;
    let nonce = unb64(&v.nonce_b64)?;
    let ct = unb64(&v.ciphertext_b64)?;
    let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(
        &vault_key_bytes(&salt),
    ));
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| {
            "vault indéchiffrable (machine différente ou fichier altéré) — supprime et réenregistre la clé"
                .to_string()
        })?;
    String::from_utf8(plain)
        .map_err(|_| "vault corrompu (contenu invalide) — supprime et réenregistre la clé".to_string())
}

/// Chiffre + persiste la clé vérifiée (atomique + 0600 Unix, cf. `write_lockfile`).
/// N'est appelé QU'après vérification réussie : l'ancienne n'est jamais
/// écrasée par une clé refusée. Conserve télémétrie + budget session.
pub fn save_vault(
    cache_dir: &Path,
    key: &str,
    verified_at: &str,
    model: &str,
) -> Result<LlmStatus, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let clean = key.trim();
    if clean.is_empty() {
        return Err("Clé vide — colle ta clé Meta dans le champ".to_string());
    }
    let prev = read_vault(cache_dir).ok();
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut salt)
        .map_err(|e| format!("aléa indisponible (vault) : {e}"))?;
    getrandom::fill(&mut nonce)
        .map_err(|e| format!("aléa indisponible (vault) : {e}"))?;
    let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(
        &vault_key_bytes(&salt),
    ));
    let ct = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), clean.as_bytes())
        .map_err(|e| format!("chiffrement vault : {e}"))?;
    let v = VaultFile {
        version: VAULT_VERSION,
        salt_b64: b64(&salt),
        nonce_b64: b64(&nonce),
        ciphertext_b64: b64(&ct),
        mask: mask_key(clean),
        verified_at: verified_at.to_string(),
        model: model.to_string(),
        telemetry_opt_in: prev.as_ref().map(|p| p.telemetry_opt_in).unwrap_or(false),
        session_tokens: prev.as_ref().map(|p| p.session_tokens).unwrap_or(0),
    };
    let json = serde_json::to_string_pretty(&v)
        .map_err(|e| format!("sérialisation vault : {e}"))?;
    let path = vault_file(cache_dir);
    crate::boot::atomic_write(&path, json.as_bytes())
        .map_err(|e| format!("écriture vault : {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("durcissement vault (0600) : {e}"))?;
    }
    Ok(LlmStatus {
        configured: true,
        mask: v.mask,
        verified_at: Some(v.verified_at),
        model: v.model,
        telemetry_opt_in: v.telemetry_opt_in,
        session_tokens: v.session_tokens,
    })
}

/// Déchiffre la clé stockée (backend uniquement, jamais vers le frontend).
/// `Err` explicite si absente/corrompue — sans jamais fuiter de secret.
pub fn load_vault_key(cache_dir: &Path) -> Result<String, String> {
    let v = read_vault(cache_dir)?;
    decrypt_key(&v)
}

/// Métadonnées affichables (masque + statut), sans la clé.
pub fn load_vault_meta(cache_dir: &Path) -> Option<LlmStatus> {
    let v = read_vault(cache_dir).ok()?;
    Some(LlmStatus {
        configured: true,
        mask: v.mask,
        verified_at: Some(v.verified_at),
        model: v.model,
        telemetry_opt_in: v.telemetry_opt_in,
        session_tokens: v.session_tokens,
    })
}

/// Supprime le vault. `Ok(true)` si un vault existait, `Ok(false)` sinon.
/// Après suppression : panneau agent désactivé, app 100 % utilisable.
pub fn clear_vault(cache_dir: &Path) -> Result<bool, String> {
    let path = vault_file(cache_dir);
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path).map_err(|e| format!("suppression vault : {e}"))?;
    Ok(true)
}

// --- Transport (seule couture mockée) ------------------------------------------

/// Réponse brute : (statut HTTP, `Retry-After` brut, corps).
pub type RawResponse = (u16, Option<String>, String);

/// Futur de transport boxé (object-safe) : le `Sleep`/`op` injectés en test
/// restent synchrones, seul le transport réel est asynchrone.
pub type TransportFut<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<RawResponse, String>> + Send + 'a>>;
pub type SleepFut = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// Bord système : le HTTP réel. Prod = `reqwest`, tests = `FakeTransport`.
/// Async de bout en bout : les commandes Tauri `async` tournent sur le pool
/// du runtime — aucun `block_on` (qui paniquait sur le thread principal,
/// sans runtime : crash à la validation de clé).
pub trait LlmTransport: Send + Sync {
    fn get_models<'a>(&'a self, url: &'a str, key: &'a str) -> TransportFut<'a>;
    fn post_chat<'a>(&'a self, url: &'a str, key: &'a str, body: &'a str) -> TransportFut<'a>;
}

/// Composition testable (sans réseau) : vérifie via le transport puis
/// persiste SSI la clé est acceptée. L'ancienne clé survit à un refus.
pub async fn verify_and_save_core(
    cache_dir: &Path,
    project: Option<&str>,
    key: &str,
    now_rfc3339: &str,
    transport: &dyn LlmTransport,
) -> Result<LlmStatus, String> {
    let _project = require_project_open(project)?;
    let clean = key.trim();
    if clean.is_empty() {
        return Err("Clé vide — colle ta clé Meta dans le champ".to_string());
    }
    let url = models_url(META_API_BASE)?;
    // `transport` ne voit que des URLs allowlistées (construites ci-dessus).
    debug_assert!(is_url_allowed(&url));
    let (status, retry_after_raw, body) = transport.get_models(&url, clean).await?;
    let retry = parse_retry_after(retry_after_raw.as_deref());
    let _models = interpret_models_response(status, retry, &body)?;
    save_vault(cache_dir, clean, now_rfc3339, DEFAULT_MODEL)
}

/// Composition testable de la liste live (US7/US9) : `GET /v1/models`
/// (coût nul) via allowlist, avec la clé du vault. Échec rapide sans retry :
/// le frontend conserve son repli codé (liste vide ou erreur → repli).
/// Exige un Projet ouvert (G3, comme tout appel fournisseur).
pub async fn list_models_core(
    cache_dir: &Path,
    project: Option<&str>,
    transport: &dyn LlmTransport,
) -> Result<Vec<String>, String> {
    let _project = require_project_open(project)?;
    let key = load_vault_key(cache_dir)?;
    let url = models_url(META_API_BASE)?;
    // `transport` ne voit que des URLs allowlistées (construites ci-dessus).
    debug_assert!(is_url_allowed(&url));
    let (status, retry_after_raw, body) = transport.get_models(&url, &key).await?;
    let retry = parse_retry_after(retry_after_raw.as_deref());
    interpret_models_response(status, retry, &body)
}

/// Composition testable : re-vérifie la clé stockée sans l'écraser.
/// 401 → `Err("…rouvre les Paramètres…")` pour le bandeau chat.
pub async fn test_stored_core(
    cache_dir: &Path,
    project: Option<&str>,
    transport: &dyn LlmTransport,
) -> Result<LlmStatus, String> {
    let _project = require_project_open(project)?;
    let key = load_vault_key(cache_dir)?;
    let url = models_url(META_API_BASE)?;
    debug_assert!(is_url_allowed(&url));
    let (status, retry_after_raw, body) = transport.get_models(&url, &key).await?;
    let retry = parse_retry_after(retry_after_raw.as_deref());
    match interpret_models_response(status, retry, &body) {
        Ok(_) => load_vault_meta(cache_dir).ok_or_else(|| {
            "aucune clé configurée — colle ta clé dans les Paramètres".to_string()
        }),
        Err(_) if status == 401 || status == 403 => Err(
            "Clé refusée — rouvre les Paramètres pour la remplacer".to_string(),
        ),
        Err(e) => Err(e),
    }
}

/// Requête agent (commande dédiée unique) : consentement explicite exigé,
/// budgets + plafond + allowlist appliqués avant tout réseau.
/// Champs camelCase côté IPC (`maxTokens`), snake côté Rust.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub input: String,
    pub max_tokens: u32,
    pub consent: bool,
    /// `"chat"` (Chat Completions) ou `"responses"` (Responses).
    pub mode: String,
}

/// Contrôles pré-envoi : consentement, taille, `max_tokens`, budget.
/// Retourne l'estimation de jetons (≈ caractères / 4 + `max_tokens`).
pub fn check_chat_request(req: &ChatRequest, session_tokens: u64) -> Result<u64, String> {
    if !req.consent {
        return Err(
            "Consentement pré-envoi requis — valide le récapitulatif (opt-in)".to_string(),
        );
    }
    if req.mode != "chat" && req.mode != "responses" {
        return Err(format!(
            "mode inconnu « {} » (attendus : chat, responses)",
            req.mode
        ));
    }
    check_payload_size(req.input.chars().count())?;
    if req.max_tokens == 0 || req.max_tokens > MAX_TOKENS_HARD {
        return Err(format!(
            "max_tokens {} invalide (plafond {MAX_TOKENS_HARD}) — réduis la demande",
            req.max_tokens
        ));
    }
    let estimated =
        (req.input.chars().count() / 4).saturating_add(req.max_tokens as usize) as u64;
    check_budget(session_tokens, estimated)?;
    Ok(estimated)
}

// --- Transport prod + retry + appel agent (tranche 2) --------------------------

/// Réponse d'appel agent (frontend : texte + compteur, jamais la clé).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    pub tokens_used: u64,
    pub model: String,
}

/// Transport prod : `reqwest`, allowlist vérifiée AVANT tout envoi.
/// Seule implémentation hors tests autorisée à émettre vers le LLM.
pub struct ReqwestTransport;

impl ReqwestTransport {
    pub fn new() -> Self {
        Self
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("client HTTP LLM")
    })
}

fn host_of(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/').next().unwrap_or(rest)
}

async fn read_raw_response(
    resp: reqwest::Response,
) -> Result<RawResponse, String> {
    let status = resp.status().as_u16();
    let retry = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp.text().await.map_err(|_| transport_error_msg())?;
    Ok((status, retry, body))
}

impl LlmTransport for ReqwestTransport {
    fn get_models<'a>(&'a self, url: &'a str, key: &'a str) -> TransportFut<'a> {
        Box::pin(async move {
            if !is_url_allowed(url) {
                return Err(format!("hôte non autorisé (allowlist) : {}", host_of(url)));
            }
            let resp = http_client()
                .get(url)
                .bearer_auth(key)
                .send()
                .await
                .map_err(|_| transport_error_msg())?;
            let status = resp.status().as_u16();
            eprintln!("[llm] GET {} -> {status}", sanitize_for_log(url, &[]));
            read_raw_response(resp).await
        })
    }

    fn post_chat<'a>(&'a self, url: &'a str, key: &'a str, body: &'a str) -> TransportFut<'a> {
        Box::pin(async move {
            if !is_url_allowed(url) {
                return Err(format!("hôte non autorisé (allowlist) : {}", host_of(url)));
            }
            let resp = http_client()
                .post(url)
                .bearer_auth(key)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/json",
                )
                .body(body.to_string())
                .send()
                .await
                .map_err(|_| transport_error_msg())?;
            let status = resp.status().as_u16();
            // G8 : statut + taille uniquement, jamais le prompt ni la clé.
            eprintln!("[llm] POST {} -> {status}", sanitize_for_log(url, &[]));
            read_raw_response(resp).await
        })
    }
}

/// Boucle retry 429/5xx (honore `Retry-After`, backoff plafonné, jitter à
/// l'appel) ; `sleep` injecté pour testabilité. Ni les erreurs transport
/// (hors-ligne : échec rapide, cf. offline-first) ni les 401/402/403 ne se
/// rejouent.
pub async fn call_with_retry<'a>(
    op: &mut (dyn FnMut() -> TransportFut<'a> + Send + 'a),
    sleep: &(dyn Fn(u64) -> SleepFut + Send + Sync),
) -> Result<RawResponse, String> {
    let mut last = op().await?;
    for attempt in 0..MAX_ATTEMPTS {
        let status = last.0;
        if !should_retry(status) {
            return Ok(last);
        }
        if attempt + 1 >= MAX_ATTEMPTS {
            return Err(format!(
                "abandon après {MAX_ATTEMPTS} tentatives (dernier statut {status}) — réessaie plus tard"
            ));
        }
        sleep(backoff_delay_ms(
            attempt,
            parse_retry_after(last.1.as_deref()),
        ))
        .await;
        last = op().await?;
    }
    Ok(last)
}

/// Interprète une réponse d'appel agent : `Ok((texte, jetons))` si 200
/// (extraction best-effort selon le mode + `usage`, repli `estimated`),
/// `Err` français précis sinon (401 → bandeau « rouvre les Paramètres »).
/// Texte vide accepté (réponses tool-only du ticket agent ultérieur) :
/// jamais de défaut silencieux, le compteur fait foi.
pub fn interpret_chat_response(
    status: u16,
    retry_after_secs: Option<u64>,
    body: &str,
    mode: &str,
    estimated: u64,
) -> Result<(String, u64), String> {
    match status {
        200 => {
            let v: serde_json::Value = serde_json::from_str(body).map_err(|_| {
                "réponse modèle illisible — réessaie".to_string()
            })?;
            let (text, tokens) = if mode == "responses" {
                let text = v
                    .get("output")
                    .and_then(|o| o.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter(|e| e.get("type").and_then(|t| t.as_str()) == Some("message"))
                            .filter_map(|e| e.get("content")?.as_array())
                            .flatten()
                            .filter(|c| {
                                c.get("type").and_then(|t| t.as_str()) == Some("output_text")
                            })
                            .filter_map(|c| c.get("text")?.as_str())
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                let tokens = v
                    .get("usage")
                    .and_then(|u| {
                        let i = u.get("input_tokens")?.as_u64()?;
                        let o = u.get("output_tokens")?.as_u64()?;
                        Some(i.saturating_add(o))
                    })
                    .unwrap_or(estimated);
                (text, tokens)
            } else {
                let text = v
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|c| c.get("message")?.get("content")?.as_str())
                    .unwrap_or_default()
                    .to_string();
                let tokens = v
                    .get("usage")
                    .and_then(|u| u.get("total_tokens")?.as_u64())
                    .unwrap_or(estimated);
                (text, tokens)
            };
            Ok((text, tokens))
        }
        401 | 403 => Err("Clé refusée — rouvre les Paramètres pour la remplacer".to_string()),
        429 => {
            let wait =
                retry_after_secs.unwrap_or_else(|| backoff_delay_ms(0, None) / 1_000);
            Err(format!("Quota atteint (429) — patiente {wait} s puis réessaie"))
        }
        500..=599 => Err(format!(
            "Fournisseur indisponible ({status}) — réessaie dans un instant"
        )),
        other => Err(format!(
            "Appel refusé (HTTP {other}) — réessaie ou vérifie la clé dans les Paramètres"
        )),
    }
}

/// Composition testable de la commande dédiée unique : contrôles pré-envoi,
/// clé du vault, URL allowlistée, retry, compteur session persisté.
/// Le `sleep` réel est async (tokio) : les commandes sont `async`, aucun
/// thread n'est bloqué ; les tests injectent un no-op enregistreur.
pub async fn complete_core(
    cache_dir: &Path,
    project: Option<&str>,
    req: &ChatRequest,
    transport: &dyn LlmTransport,
    sleep: &(dyn Fn(u64) -> SleepFut + Send + Sync),
) -> Result<ChatReply, String> {
    let project = require_project_open(project)?;
    // Budget lu du vault (0 si absent — `load_vault_key` refusera juste après).
    let session = load_vault_meta(cache_dir).map(|m| m.session_tokens).unwrap_or(0);
    let estimated = check_chat_request(req, session)?;
    let key = load_vault_key(cache_dir)?;
    let url = chat_url(META_API_BASE, &req.mode)?;
    debug_assert!(is_url_allowed(&url));
    // Minimisation : chemins absolus relativisés avant envoi (étude §5).
    let input = relativize_paths(&req.input, &project);
    let body = if req.mode == "responses" {
        serde_json::json!({"model": req.model, "input": input, "max_tokens": req.max_tokens})
    } else {
        serde_json::json!({"model": req.model, "messages": [{"role": "user", "content": input}], "max_tokens": req.max_tokens})
    }
    .to_string();
    let mut op = || transport.post_chat(&url, &key, &body);
    let (status, retry_raw, resp_body) = call_with_retry(&mut op, sleep).await?;
    let retry = parse_retry_after(retry_raw.as_deref());
    let (text, used) = interpret_chat_response(status, retry, &resp_body, &req.mode, estimated)?;
    add_session_tokens(cache_dir, used)?;
    Ok(ChatReply {
        text,
        tokens_used: used,
        model: req.model.clone(),
    })
}

/// Incrémente le compteur session du vault (sans retoucher au chiffré).
fn add_session_tokens(cache_dir: &Path, used: u64) -> Result<(), String> {
    let path = vault_file(cache_dir);
    let text = std::fs::read_to_string(&path).map_err(|_| {
        "aucune clé configurée — colle ta clé dans les Paramètres".to_string()
    })?;
    let mut v: VaultFile = serde_json::from_str(&text)
        .map_err(|_| "vault corrompu (JSON illisible) — supprime et réenregistre la clé".to_string())?;
    v.session_tokens = v.session_tokens.saturating_add(used);
    let json =
        serde_json::to_string_pretty(&v).map_err(|e| format!("sérialisation vault : {e}"))?;
    crate::boot::atomic_write(&path, json.as_bytes())
        .map_err(|e| format!("écriture vault : {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("durcissement vault (0600) : {e}"))?;
    }
    Ok(())
}

/// Persistance télémétrie opt-in (défaut `false`, G8) : exige une clé
/// configurée, ne touche ni à la clé ni au compteur.
fn set_telemetry_optin(cache_dir: &Path, optin: bool) -> Result<LlmStatus, String> {
    let _key = load_vault_key(cache_dir)?;
    let path = vault_file(cache_dir);
    let text = std::fs::read_to_string(&path).map_err(|_| {
        "aucune clé configurée — colle ta clé dans les Paramètres".to_string()
    })?;
    let mut v: VaultFile = serde_json::from_str(&text)
        .map_err(|_| "vault corrompu (JSON illisible) — supprime et réenregistre la clé".to_string())?;
    v.telemetry_opt_in = optin;
    let json =
        serde_json::to_string_pretty(&v).map_err(|e| format!("sérialisation vault : {e}"))?;
    crate::boot::atomic_write(&path, json.as_bytes())
        .map_err(|e| format!("écriture vault : {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("durcissement vault (0600) : {e}"))?;
    }
    load_vault_meta(cache_dir).ok_or_else(|| {
        "aucune clé configurée — colle ta clé dans les Paramètres".to_string()
    })
}

// --- Commandes Tauri (surface IPC ; cœur testable ci-dessus) -------------------
// Frontend : jamais de clé (seulement `LlmStatus`), jamais de fetch direct
// (CSP `connect-src` inchangée — le réseau LLM vit ici uniquement).

#[tauri::command]
pub fn llm_status() -> Result<LlmStatus, String> {
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Ok(unconfigured_status());
    };
    Ok(load_vault_meta(&cache).unwrap_or_else(unconfigured_status))
}

#[tauri::command]
pub async fn llm_verify_and_save(
    state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::BootState>>>,
    key: String,
) -> Result<LlmStatus, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    let now = chrono::Utc::now().to_rfc3339();
    verify_and_save_core(&cache, project.as_deref(), &key, &now, &ReqwestTransport::new()).await
}

#[tauri::command]
pub async fn llm_test(
    state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::BootState>>>,
) -> Result<LlmStatus, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    test_stored_core(&cache, project.as_deref(), &ReqwestTransport::new()).await
}

/// Liste live des modèles (US7/US9) : `GET /v1/models` (coût nul) via
/// allowlist, avec la clé du vault. Le frontend conserve son repli codé
/// en cas d'erreur ou de liste vide — cette commande n'émet jamais de
/// secret, seulement des identifiants de modèles.
#[tauri::command]
pub async fn llm_models(
    state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::BootState>>>,
) -> Result<Vec<String>, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    list_models_core(&cache, project.as_deref(), &ReqwestTransport::new()).await
}

#[tauri::command]
pub fn llm_clear() -> Result<bool, String> {
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    clear_vault(&cache)
}

#[tauri::command]
pub fn llm_set_telemetry(optin: bool) -> Result<LlmStatus, String> {
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    set_telemetry_optin(&cache, optin)
}

#[tauri::command]
pub async fn llm_complete(
    state: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::BootState>>>,
    req: ChatRequest,
) -> Result<ChatReply, String> {
    let project = state.lock().expect("boot state").project_path.clone();
    let Some(cache) = crate::boot::base_cache_dir() else {
        return Err("cache_dir indisponible".into());
    };
    // Jitter borné 0–500 ms ajouté au backoff, dormi en async (aucun thread
    // bloqué — les commandes sont `async`) ; `complete_core` reçoit le
    // `sleep` injecté en test.
    let sleep = |ms: u64| {
        let jitter: u64 = {
            let mut b = [0u8; 8];
            getrandom::fill(&mut b).map(|_| u64::from_ne_bytes(b) % 500).unwrap_or(0)
        };
        Box::pin(tokio::time::sleep(Duration::from_millis(ms.saturating_add(jitter)))) as SleepFut
    };
    complete_core(&cache, project.as_deref(), &req, &ReqwestTransport::new(), &sleep).await
}

// --- Tests (spec exécutable, cf. skill tdd : RED d'abord) -----------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeTransport {
        calls: std::sync::Mutex<Vec<String>>,
        replies: std::sync::Mutex<HashMap<String, Result<RawResponse, String>>>,
    }

    impl FakeTransport {
        fn replying(url: &str, r: Result<RawResponse, String>) -> Self {
            let mut m = HashMap::new();
            m.insert(url.to_string(), r);
            Self {
                calls: std::sync::Mutex::new(Vec::new()),
                replies: std::sync::Mutex::new(m),
            }
        }
    }

    impl LlmTransport for FakeTransport {
        fn get_models<'a>(&'a self, url: &'a str, _key: &'a str) -> TransportFut<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(url.to_string());
                self.replies
                    .lock()
                    .unwrap()
                    .get(url)
                    .cloned()
                    .unwrap_or(Err(transport_error_msg()))
            })
        }
        fn post_chat<'a>(&'a self, url: &'a str, _key: &'a str, _body: &'a str) -> TransportFut<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(url.to_string());
                Err("non câblé".to_string())
            })
        }
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nia-llm-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // --- masque -----------------------------------------------------------------

    #[test]
    fn masque_n_expose_que_4_derniers() {
        assert_eq!(mask_key("abcdefgh1234"), "••••1234");
    }

    #[test]
    fn masque_cle_courte_sans_fuite() {
        assert_eq!(mask_key("abc"), "••••");
        assert!(!mask_key("abc").contains("abc"));
    }

    // --- allowlist (deny prioritaire) --------------------------------------------

    #[test]
    fn allowlist_meta_et_localhost_uniquement() {
        assert!(is_url_allowed("https://api.meta.ai/v1/models"));
        assert!(is_url_allowed("https://api.meta.ai/v1/chat/completions"));
        assert!(is_url_allowed("https://api.meta.ai/v1/responses"));
        assert!(is_url_allowed("http://localhost:11434/api/chat"));
        assert!(is_url_allowed("http://127.0.0.1:11434/v1/models"));
    }

    #[test]
    fn allowlist_refuse_tout_le_reste_deny_prioritaire() {
        assert!(!is_url_allowed("http://api.meta.ai/v1/models"));
        assert!(!is_url_allowed("https://api.meta.ai/v1.evil.com/x"));
        assert!(!is_url_allowed("https://api.meta.ai/"));
        assert!(!is_url_allowed("https://evil.com/v1/models"));
        assert!(!is_url_allowed("https://api.openai.com/v1/models"));
        assert!(!is_url_allowed("https://localhost:11434/v1/models"));
        assert!(!is_url_allowed("http://localhost.evil.com/x"));
        assert!(!is_url_allowed("file:///etc/passwd"));
    }

    #[test]
    fn urls_construites_restent_allowlisted() {
        assert!(is_url_allowed(&models_url(META_API_BASE).unwrap()));
        assert!(is_url_allowed(&chat_url(META_API_BASE, "chat").unwrap()));
        assert!(is_url_allowed(&chat_url(META_API_BASE, "responses").unwrap()));
        assert!(chat_url(META_API_BASE, "ftp").is_err());
        assert!(models_url("https://evil.com").is_err());
    }

    // --- NO_PROJECT_OPEN ----------------------------------------------------------

    #[test]
    fn sans_projet_ouvert_aucun_appel() {
        let err = require_project_open(None).expect_err("None refusé");
        assert!(err.contains("NO_PROJECT_OPEN"), "{err}");
        let err = require_project_open(Some("  ")).expect_err("vide refusé");
        assert!(err.contains("NO_PROJECT_OPEN"), "{err}");
        assert_eq!(
            require_project_open(Some("/p/projet")).unwrap(),
            "/p/projet"
        );
    }

    // --- retry / backoff / budgets --------------------------------------------------

    #[test]
    fn retry_429_et_5xx_uniquement() {
        assert!(should_retry(429));
        assert!(should_retry(500));
        assert!(should_retry(503));
        for s in [400, 401, 402, 403, 404] {
            assert!(!should_retry(s), "{s} ne se rejoue pas");
        }
    }

    #[test]
    fn backoff_double_plafonne_et_honore_retry_after() {
        assert_eq!(backoff_delay_ms(0, None), 1_000);
        assert_eq!(backoff_delay_ms(1, None), 2_000);
        assert_eq!(backoff_delay_ms(2, None), 4_000);
        assert_eq!(backoff_delay_ms(10, None), 30_000);
        assert_eq!(backoff_delay_ms(0, Some(5)), 5_000);
        assert_eq!(backoff_delay_ms(0, Some(120)), 30_000);
    }

    #[test]
    fn retry_after_parse_secondes_uniquement() {
        assert_eq!(parse_retry_after(Some("7")), Some(7));
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_retry_after(Some("date-HTTP")), None);
    }

    #[test]
    fn budget_coupe_circuit_hard_limit() {
        assert!(check_budget(0, 1_000).is_ok());
        let err = check_budget(99_000, 2_000).expect_err("cap dépassé");
        assert!(err.contains("Budget"), "{err}");
    }

    #[test]
    fn payload_plafonne_refus_explicite() {
        assert!(check_payload_size(1_000).is_ok());
        let err = check_payload_size(100_000).expect_err("trop gros");
        assert!(err.contains("volumineux"), "{err}");
    }

    // --- logs assainis / minimisation / consentement ----------------------------------

    #[test]
    fn logs_caviardes_sans_secrets() {
        let out = sanitize_for_log("Authorization: Bearer SECRET123 appel", &["SECRET123"]);
        assert!(!out.contains("SECRET123"), "{out}");
        assert!(out.contains("[CAVIARDÉ]"), "{out}");
    }

    #[test]
    fn chemins_relativises_avant_envoi() {
        assert_eq!(
            relativize_paths("/home/u/projet/main.tsx", "/home/u/projet"),
            "<Projet>/main.tsx"
        );
    }

    #[test]
    fn recapitulatif_pre_envoi_explicite() {
        let s = summarize_for_consent(120, 14);
        assert!(s.contains("120"), "{s}");
        assert!(s.contains("14"), "{s}");
        assert!(s.contains("relativisés") || s.contains("relativise"), "{s}");
    }

    // --- interprétation modèles ------------------------------------------------------

    #[test]
    fn modeles_200_liste_ids() {
        let ids =
            interpret_models_response(200, None, r#"{"data":[{"id":"a"},{"id":"b"}]}"#).unwrap();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn modeles_200_inattendu_repli_liste_vide() {
        assert_eq!(interpret_models_response(200, None, "{}").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn modeles_401_cle_invalide() {
        let err = interpret_models_response(401, None, "nope").expect_err("401");
        assert!(err.contains("invalide") || err.contains("révoquée"), "{err}");
    }

    #[test]
    fn modeles_429_patienter_avec_retry_after() {
        let err = interpret_models_response(429, Some(7), "lent").expect_err("429");
        assert!(err.contains("429"), "{err}");
        assert!(err.contains('7'), "{err}");
    }

    #[test]
    fn modeles_500_fournisseur_indisponible() {
        let err = interpret_models_response(500, None, "boom").expect_err("500");
        assert!(err.contains("indisponible"), "{err}");
    }

    #[test]
    fn transport_ko_hors_ligne_sans_appel() {
        assert!(transport_error_msg().contains("Hors-ligne"));
    }

    // --- vault chiffré -----------------------------------------------------------------

    #[test]
    fn vault_roundtrip_jamais_en_clair() {
        let dir = tmpdir("roundtrip");
        let key = "FAUSSE-CLE-TEST-ARR-0001";
        let st = save_vault(&dir, key, "2026-11-04T10:00:00Z", "default").unwrap();
        assert!(st.configured);
        assert_eq!(st.mask, "••••0001");
        assert_eq!(load_vault_key(&dir).unwrap(), key);
        let raw = std::fs::read(vault_file(&dir)).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains(key), "clé en clair dans le fichier !");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_absent_erreur_sans_secret() {
        let dir = tmpdir("absent");
        let err = load_vault_key(&dir).expect_err("absent");
        assert!(err.contains("aucune clé") || err.contains("configurée"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- cycle : enregistrer → refuser → remplacer → supprimer ------------------------------

    #[tokio::test]
    async fn cycle_fausse_cle_refusee_ancienne_conservee() {
        let dir = tmpdir("cycle");
        let url = models_url(META_API_BASE).unwrap();
        // D'abord une clé valide enregistrée.
        let ok = FakeTransport::replying(&url, Ok((200, None, r#"{"data":[]}"#.into())));
        let st = verify_and_save_core(
            &dir,
            Some("/p/projet"),
            "BONNE-CLE-TEST-AAAA-1111",
            "2026-11-04T10:00:00Z",
            &ok,
        ).await
        .unwrap();
        assert_eq!(st.mask, "••••1111");
        // Puis une fausse clé refusée (401) : l'ancienne survit.
        let ko = FakeTransport::replying(&url, Ok((401, None, "bad".into())));
        let err = verify_and_save_core(
            &dir,
            Some("/p/projet"),
            "FAUSSE-CLE-XXXX-9999",
            "2026-11-04T10:01:00Z",
            &ko,
        ).await
        .expect_err("401 = refus");
        assert!(err.contains("invalide") || err.contains("révoquée"), "{err}");
        assert_eq!(load_vault_key(&dir).unwrap(), "BONNE-CLE-TEST-AAAA-1111");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn verify_sans_projet_refuse_avant_reseau() {
        let dir = tmpdir("noproject");
        let t = FakeTransport::replying("jamais", Ok((200, None, "{}".into())));
        let err = verify_and_save_core(&dir, None, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", &t).await
            .expect_err("NO_PROJECT_OPEN");
        assert!(err.contains("NO_PROJECT_OPEN"), "{err}");
        assert!(t.calls.lock().unwrap().is_empty(), "aucun appel réseau");
        assert!(!vault_file(&dir).exists(), "rien persisté");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn tester_cle_refusee_bandeau_rouvre_parametres() {
        let dir = tmpdir("testrefuse");
        let url = models_url(META_API_BASE).unwrap();
        let ok = FakeTransport::replying(&url, Ok((200, None, r#"{"data":[]}"#.into())));
        verify_and_save_core(&dir, Some("/p"), "CLE-TEST-12345678", "2026-11-04T10:00:00Z", &ok).await
            .unwrap();
        let ko = FakeTransport::replying(&url, Ok((401, None, "revoquee".into())));
        let err =
            test_stored_core(&dir, Some("/p"), &ko).await.expect_err("clé révoquée → bandeau");
        assert!(err.contains("Paramètres"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn supprimer_desactive_sans_casser_l_app() {
        let dir = tmpdir("supprime");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        assert!(clear_vault(&dir).unwrap());
        assert!(!clear_vault(&dir).unwrap(), "idempotent");
        assert!(load_vault_key(&dir).is_err());
        assert!(!load_vault_meta(&dir).map(|s| s.configured).unwrap_or(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- requête chat : consentement + plafonds ----------------------------------------------

    #[test]
    fn chat_sans_consentement_refuse() {
        let req = ChatRequest {
            model: "default".into(),
            input: "bonjour".into(),
            max_tokens: 100,
            consent: false,
            mode: "chat".into(),
        };
        let err = check_chat_request(&req, 0).expect_err("opt-in requis");
        assert!(err.contains("Consentement"), "{err}");
    }

    #[test]
    fn chat_plafonds_max_tokens_et_taille() {        let gros = ChatRequest {
            model: "default".into(),
            input: "x".repeat(100_000),
            max_tokens: 100,
            consent: true,
            mode: "chat".into(),
        };
        assert!(check_chat_request(&gros, 0).is_err());
        let top = ChatRequest {
            model: "default".into(),
            input: "ok".into(),
            max_tokens: 90_000,
            consent: true,
            mode: "chat".into(),
        };
        let err = check_chat_request(&top, 0).expect_err("hard limit");
        assert!(err.contains("max_tokens"), "{err}");
    }

    // --- tranche 2 : transport prod, retry, appel agent -------------------------

    use std::collections::VecDeque;

    struct ScriptTransport {
        calls: std::sync::Mutex<Vec<String>>,
        queue: std::sync::Mutex<VecDeque<Result<RawResponse, String>>>,
    }

    impl ScriptTransport {
        fn scripted(replies: Vec<Result<RawResponse, String>>) -> Self {
            Self {
                calls: std::sync::Mutex::new(Vec::new()),
                queue: std::sync::Mutex::new(replies.into()),
            }
        }
        fn ncalls(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    impl LlmTransport for ScriptTransport {
        fn get_models<'a>(&'a self, url: &'a str, _key: &'a str) -> TransportFut<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(url.to_string());
                self.queue.lock().unwrap().pop_front().unwrap_or(Err("script épuisé".into()))
            })
        }
        fn post_chat<'a>(&'a self, url: &'a str, _key: &'a str, _body: &'a str) -> TransportFut<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(url.to_string());
                self.queue.lock().unwrap().pop_front().unwrap_or(Err("script épuisé".into()))
            })
        }
    }

    #[tokio::test]
    async fn prod_transport_refuse_hors_allowlist_sans_reseau() {
        let t = ReqwestTransport::new();
        let err = t.get_models("https://evil.com/v1/models", "k").await.expect_err("deny");
        assert!(err.contains("allowlist"), "{err}");
        let err = t.post_chat("https://api.openai.com/v1/chat/completions", "k", "{}").await.expect_err("deny");
        assert!(err.contains("allowlist"), "{err}");
    }

    /// Régression crash validation de clé : le transport réel doit pouvoir
    /// tourner DANS un contexte async (commandes Tauri `async`) sans
    /// `block_on` — qui paniquait sur le thread principal ("no reactor
    /// running") et tuait l'app (release `panic = "abort"`).
    /// Serveur stub local (127.0.0.1 allowlisté), aucune clé réelle.
    #[tokio::test]
    async fn prod_transport_fonctionne_en_contexte_async_sans_block_on() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = r#"{"data":[{"id":"muse-spark-1.3"}]}"#;
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        std::thread::spawn(move || {
            use std::io::Write;
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            use std::io::Read;
            let _ = stream.read(&mut buf);
            stream.write_all(raw.as_bytes()).unwrap();
            stream.flush().unwrap();
        });
        let t = ReqwestTransport::new();
        let url = format!("http://127.0.0.1:{port}/v1/models");
        // Si un `block_on` subsistait, cette ligne paniquerait ici même.
        let (status, _, resp_body) = t.get_models(&url, "FAUSSE-CLE-TEST").await.unwrap();
        assert_eq!(status, 200);
        assert!(resp_body.contains("muse-spark-1.3"), "{resp_body}");
    }

    #[tokio::test]
    async fn retry_429_puis_succes() {
        let t = ScriptTransport::scripted(vec![
            Ok((429, Some("0".into()), "lent".into())),
            Ok((200, None, r#"{"choices":[]}"#.into())),
        ]);
        let slept = std::sync::Mutex::new(Vec::new());
        let out = call_with_retry(
            &mut || t.post_chat("https://api.meta.ai/v1/chat/completions", "k", "{}"),
            &|ms: u64| -> SleepFut { slept.lock().unwrap().push(ms); Box::pin(async {}) },
        ).await
        .unwrap();
        assert_eq!(out.0, 200);
        assert_eq!(t.ncalls(), 2);
        assert_eq!(slept.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn pas_de_retry_sur_401() {
        let t = ScriptTransport::scripted(vec![Ok((401, None, "non".into()))]);
        let out = call_with_retry(
            &mut || t.post_chat("https://api.meta.ai/v1/chat/completions", "k", "{}"),
            &|_: u64| -> SleepFut { Box::pin(async {}) },
        ).await
        .unwrap();
        assert_eq!(out.0, 401);
        assert_eq!(t.ncalls(), 1, "401 ne se rejoue jamais");
    }

    #[tokio::test]
    async fn abandon_apres_max_tentatives() {
        let t = ScriptTransport::scripted(vec![
            Ok((500, None, "a".into())),
            Ok((503, None, "b".into())),
            Ok((500, None, "c".into())),
            Ok((500, None, "d".into())),
        ]);
        let err = call_with_retry(
            &mut || t.post_chat("https://api.meta.ai/v1/chat/completions", "k", "{}"),
            &|_: u64| -> SleepFut { Box::pin(async {}) },
        ).await
        .expect_err("abandon");
        assert!(err.contains("tentatives"), "{err}");
        assert_eq!(t.ncalls(), 3, "1 essai + 2 retries");
    }

    #[test]
    fn chat_200_extrait_texte_et_tokens() {
        let body = r#"{"choices":[{"message":{"content":"bonjour"}}],"usage":{"total_tokens":42}}"#;
        let (text, tokens) = interpret_chat_response(200, None, body, "chat", 7).unwrap();
        assert_eq!(text, "bonjour");
        assert_eq!(tokens, 42);
        let body = r#"{"output":[{"type":"message","content":[{"type":"output_text","text":"salut"}]}],"usage":{"input_tokens":10,"output_tokens":5}}"#;
        let (text, tokens) = interpret_chat_response(200, None, body, "responses", 7).unwrap();
        assert_eq!(text, "salut");
        assert_eq!(tokens, 15);
    }

    #[test]
    fn chat_200_sans_usage_repli_estimation() {
        let body = r#"{"choices":[{"message":{"content":"hi"}}]}"#;
        let (text, tokens) = interpret_chat_response(200, None, body, "chat", 9).unwrap();
        assert_eq!(text, "hi");
        assert_eq!(tokens, 9);
    }

    #[tokio::test]
    async fn chat_401_bandeau_rouvre_parametres() {
        let dir = tmpdir("chat401");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        let t = ScriptTransport::scripted(vec![Ok((401, None, "non".into()))]);
        let req = ChatRequest {
            model: "default".into(),
            input: "bonjour".into(),
            max_tokens: 100,
            consent: true,
            mode: "chat".into(),
        };
        let err = complete_core(&dir, Some("/p"), &req, &t, &|_: u64| -> SleepFut { Box::pin(async {}) }).await.expect_err("401");
        assert!(err.contains("Paramètres"), "{err}");
        assert_eq!(t.ncalls(), 1, "401 ne se rejoue jamais");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn chat_sans_cle_refuse_avant_reseau() {
        let dir = tmpdir("chatnocle");
        let t = ScriptTransport::scripted(vec![Ok((200, None, "{}".into()))]);
        let req = ChatRequest {
            model: "default".into(),
            input: "bonjour".into(),
            max_tokens: 100,
            consent: true,
            mode: "chat".into(),
        };
        let err = complete_core(&dir, Some("/p"), &req, &t, &|_: u64| -> SleepFut { Box::pin(async {}) }).await.expect_err("sans clé");
        assert!(err.contains("aucune clé"), "{err}");
        assert_eq!(t.ncalls(), 0, "aucun appel réseau");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn chat_sans_projet_refuse_avant_reseau() {
        let dir = tmpdir("chatnoproject");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        let t = ScriptTransport::scripted(vec![Ok((200, None, "{}".into()))]);
        let req = ChatRequest {
            model: "default".into(),
            input: "bonjour".into(),
            max_tokens: 100,
            consent: true,
            mode: "chat".into(),
        };
        let err = complete_core(&dir, None, &req, &t, &|_: u64| -> SleepFut { Box::pin(async {}) }).await.expect_err("NO_PROJECT_OPEN");
        assert!(err.contains("NO_PROJECT_OPEN"), "{err}");
        assert_eq!(t.ncalls(), 0, "aucun appel réseau");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn chat_succes_compte_jetons_session() {        let dir = tmpdir("chatok");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        let body = r#"{"choices":[{"message":{"content":"ok"}}],"usage":{"total_tokens":30}}"#;
        let t = ScriptTransport::scripted(vec![Ok((200, None, body.into()))]);
        let req = ChatRequest {
            model: "default".into(),
            input: "bonjour".into(),
            max_tokens: 100,
            consent: true,
            mode: "chat".into(),
        };
        let reply = complete_core(&dir, Some("/p/projet"), &req, &t, &|_: u64| -> SleepFut { Box::pin(async {}) }).await.unwrap();
        assert_eq!(reply.text, "ok");
        assert_eq!(reply.tokens_used, 30);
        let meta = load_vault_meta(&dir).unwrap();
        assert_eq!(meta.session_tokens, 30, "compteur persisté");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn telemetrie_opt_in_defaut_off_puis_on() {
        let dir = tmpdir("telemetry");
        let st = save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        assert!(!st.telemetry_opt_in, "défaut off (G8)");
        let st = set_telemetry_optin(&dir, true).unwrap();
        assert!(st.telemetry_opt_in);
        assert_eq!(load_vault_key(&dir).unwrap(), "CLE-TEST-12345678", "clé intacte");
        assert_eq!(st.mask, "••••5678");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- liste live `llm_models` (US7/US9) : GET /v1/models via allowlist ---

    #[tokio::test]
    async fn modeles_liste_200_ids() {
        let dir = tmpdir("modelsok");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        let url = models_url(META_API_BASE).unwrap();
        let t = FakeTransport::replying(&url, Ok((200, None, r#"{"data":[{"id":"muse-spark-1.3"},{"id":"autre"}]}"#.into())));
        let ids = list_models_core(&dir, Some("/p"), &t).await.unwrap();
        assert_eq!(ids, vec!["muse-spark-1.3".to_string(), "autre".to_string()]);
        assert_eq!(t.calls.lock().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn modeles_liste_200_enveloppe_inattendue_repli_vide() {
        let dir = tmpdir("modelsempty");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        let url = models_url(META_API_BASE).unwrap();
        let t = FakeTransport::replying(&url, Ok((200, None, "{}".into())));
        assert_eq!(list_models_core(&dir, Some("/p"), &t).await.unwrap(), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn modeles_liste_401_cle_invalide() {
        let dir = tmpdir("models401");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        let url = models_url(META_API_BASE).unwrap();
        let t = FakeTransport::replying(&url, Ok((401, None, "bad".into())));
        let err = list_models_core(&dir, Some("/p"), &t).await.expect_err("401");
        assert!(err.contains("invalide") || err.contains("révoquée"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn modeles_liste_sans_cle_refuse_avant_reseau() {
        let dir = tmpdir("modelsnocle");
        let t = ScriptTransport::scripted(vec![Ok((200, None, "{}".into()))]);
        let err = list_models_core(&dir, Some("/p"), &t).await.expect_err("sans clé");
        assert!(err.contains("aucune clé"), "{err}");
        assert_eq!(t.ncalls(), 0, "aucun appel réseau");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn modeles_liste_sans_projet_refuse_avant_reseau() {
        let dir = tmpdir("modelsnoproject");
        save_vault(&dir, "CLE-TEST-12345678", "2026-11-04T10:00:00Z", "default").unwrap();
        let t = ScriptTransport::scripted(vec![Ok((200, None, "{}".into()))]);
        let err = list_models_core(&dir, None, &t).await.expect_err("NO_PROJECT_OPEN");
        assert!(err.contains("NO_PROJECT_OPEN"), "{err}");
        assert_eq!(t.ncalls(), 0, "aucun appel réseau");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
