use crate::{crypto, vault};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub worker_url: String,
    pub token: String,
    pub passphrase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub deleted_remote: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Manifest {
    version: u32,
    notes: HashMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestEntry {
    id: String,
    hash: String,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SyncMeta {
    /// path -> last known remote updated_at we applied or pushed
    remote_updated: HashMap<String, u64>,
}

pub fn config_path(vault_dir: &Path) -> PathBuf {
    vault_dir.join(".sync.json")
}

pub fn meta_path(vault_dir: &Path) -> PathBuf {
    vault_dir.join(".sync_meta.json")
}

pub fn load_config(vault_dir: &Path) -> Result<Option<SyncConfig>, String> {
    let path = config_path(vault_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("read sync config: {err}"))?;
    let config: SyncConfig =
        serde_json::from_str(&raw).map_err(|err| format!("parse sync config: {err}"))?;
    Ok(Some(config))
}

pub fn save_config(vault_dir: &Path, config: &SyncConfig) -> Result<(), String> {
    if config.worker_url.trim().is_empty() {
        return Err("worker URL is empty".into());
    }
    if config.token.trim().is_empty() {
        return Err("token is empty".into());
    }
    if config.passphrase.is_empty() {
        return Err("passphrase is empty".into());
    }
    fs::create_dir_all(vault_dir).map_err(|err| format!("save sync config: {err}"))?;
    let raw = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    fs::write(config_path(vault_dir), raw).map_err(|err| format!("save sync config: {err}"))
}

fn load_meta(vault_dir: &Path) -> SyncMeta {
    let path = meta_path(vault_dir);
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_meta(vault_dir: &Path, meta: &SyncMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta).map_err(|err| err.to_string())?;
    fs::write(meta_path(vault_dir), raw).map_err(|err| format!("save sync meta: {err}"))
}

pub fn run_sync(vault_dir: &Path) -> Result<SyncReport, String> {
    let config = load_config(vault_dir)?.ok_or_else(|| "sync is not configured".to_string())?;
    sync_with_config(vault_dir, &config)
}

pub fn sync_with_config(vault_dir: &Path, config: &SyncConfig) -> Result<SyncReport, String> {
    let base = config.worker_url.trim().trim_end_matches('/').to_string();
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| format!("http client: {err}"))?;

    let salt = ensure_salt(&client, &base, &config.token)?;
    let key = crypto::derive_key(&config.passphrase, &salt)?;

    let mut remote = load_remote_manifest(&client, &base, &config.token, &key)?;
    let mut meta = load_meta(vault_dir);
    let local_paths = vault::list_notes(vault_dir)?;
    let local_set: HashSet<String> = local_paths.iter().cloned().collect();

    let mut pushed = 0usize;
    let mut pulled = 0usize;
    let mut deleted_remote = 0usize;

    // Pull: remote notes missing locally, or remote newer (LWW).
    let remote_paths: Vec<String> = remote.notes.keys().cloned().collect();
    for path in remote_paths {
        let entry = remote.notes.get(&path).cloned().unwrap();
        let local_body = if local_set.contains(&path) {
            Some(vault::read_note(vault_dir, &path)?)
        } else {
            None
        };

        let should_pull = match &local_body {
            None => true,
            Some(body) => {
                let local_hash = crypto::content_hash(body);
                if local_hash == entry.hash {
                    false
                } else {
                    let local_mtime = file_mtime_secs(vault_dir, &path).unwrap_or(0);
                    entry.updated_at >= local_mtime
                }
            }
        };

        if !should_pull {
            meta.remote_updated.insert(path, entry.updated_at);
            continue;
        }

        let blob = http_get_bytes(&client, &base, &config.token, &format!("/notes/{}", entry.id))?
            .ok_or_else(|| format!("missing remote note blob for {path}"))?;
        let plain = crypto::decrypt(&key, &blob)?;
        let body = String::from_utf8(plain).map_err(|err| format!("note utf8: {err}"))?;

        if local_set.contains(&path) {
            vault::write_note(vault_dir, &path, &body)?;
        } else {
            match vault::create_note(vault_dir, &path) {
                Ok(_) => {}
                Err(err) if err.contains("already exists") => {}
                Err(err) => return Err(err),
            }
            vault::write_note(vault_dir, &path, &body)?;
        }
        meta.remote_updated.insert(path.clone(), entry.updated_at);
        pulled += 1;
    }

    // Refresh local listing after pulls.
    let local_paths = vault::list_notes(vault_dir)?;
    let local_set: HashSet<String> = local_paths.iter().cloned().collect();

    // Push: local notes that differ or are new.
    for path in &local_paths {
        let body = vault::read_note(vault_dir, path)?;
        let hash = crypto::content_hash(&body);
        let mtime = file_mtime_secs(vault_dir, path).unwrap_or_else(|_| now_secs());
        let id = crypto::note_id(path);

        let needs_push = match remote.notes.get(path) {
            None => true,
            Some(entry) => {
                if entry.hash == hash {
                    false
                } else {
                    mtime >= entry.updated_at
                }
            }
        };

        if !needs_push {
            if let Some(entry) = remote.notes.get(path) {
                meta.remote_updated.insert(path.clone(), entry.updated_at);
            }
            continue;
        }

        // If path changed identity vs old remote id for same path, overwrite same id (path-keyed).
        let blob = crypto::encrypt(&key, body.as_bytes())?;
        http_put_bytes(
            &client,
            &base,
            &config.token,
            &format!("/notes/{id}"),
            &blob,
        )?;

        let updated_at = mtime.max(now_secs());
        remote.notes.insert(
            path.clone(),
            ManifestEntry {
                id: id.clone(),
                hash,
                updated_at,
            },
        );
        meta.remote_updated.insert(path.clone(), updated_at);
        pushed += 1;
    }

    // Remote deletes: paths in remote but not local — remove blob + manifest entry.
    let stale: Vec<String> = remote
        .notes
        .keys()
        .filter(|path| !local_set.contains(*path))
        .cloned()
        .collect();
    for path in stale {
        if let Some(entry) = remote.notes.remove(&path) {
            let _ = http_delete(&client, &base, &config.token, &format!("/notes/{}", entry.id));
            meta.remote_updated.remove(&path);
            deleted_remote += 1;
        }
    }

    remote.version = 1;
    let manifest_json =
        serde_json::to_vec(&remote).map_err(|err| format!("manifest encode: {err}"))?;
    let manifest_blob = crypto::encrypt(&key, &manifest_json)?;
    http_put_bytes(&client, &base, &config.token, "/manifest", &manifest_blob)?;
    save_meta(vault_dir, &meta)?;

    Ok(SyncReport {
        pushed,
        pulled,
        deleted_remote,
        message: format!("Synced — ↑{pushed} ↓{pulled}"),
    })
}

fn ensure_salt(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
) -> Result<Vec<u8>, String> {
    if let Some(existing) = http_get_bytes(client, base, token, "/salt")? {
        if existing.len() == 16 {
            return Ok(existing);
        }
        return Err("remote salt has invalid length".into());
    }
    let salt = crypto::new_salt();
    http_put_bytes(client, base, token, "/salt", &salt)?;
    Ok(salt.to_vec())
}

fn load_remote_manifest(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    key: &[u8; 32],
) -> Result<Manifest, String> {
    let Some(blob) = http_get_bytes(client, base, token, "/manifest")? else {
        return Ok(Manifest {
            version: 1,
            notes: HashMap::new(),
        });
    };
    let plain = crypto::decrypt(key, &blob)?;
    serde_json::from_slice(&plain).map_err(|err| format!("manifest decode: {err}"))
}

fn http_get_bytes(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let response = client
        .get(format!("{base}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|err| format!("GET {path}: {err}"))?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!("GET {path}: {status} {body}"));
    }
    let bytes = response
        .bytes()
        .map_err(|err| format!("GET {path} body: {err}"))?;
    Ok(Some(bytes.to_vec()))
}

fn http_put_bytes(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    path: &str,
    body: &[u8],
) -> Result<(), String> {
    let response = client
        .put(format!("{base}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/octet-stream")
        .body(body.to_vec())
        .send()
        .map_err(|err| format!("PUT {path}: {err}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Err(format!("PUT {path}: {status} {text}"));
    }
    Ok(())
}

fn http_delete(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    path: &str,
) -> Result<(), String> {
    let response = client
        .delete(format!("{base}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|err| format!("DELETE {path}: {err}"))?;
    if response.status().as_u16() == 404 || response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let text = response.text().unwrap_or_default();
    Err(format!("DELETE {path}: {status} {text}"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn file_mtime_secs(vault: &Path, rel: &str) -> Result<u64, String> {
    let path = vault.join(rel);
    let meta = fs::metadata(&path).map_err(|err| format!("stat {rel}: {err}"))?;
    let modified = meta
        .modified()
        .map_err(|err| format!("mtime {rel}: {err}"))?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0))
}
