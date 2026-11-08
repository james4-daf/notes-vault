use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

use crate::vault;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Registry {
    active: String,
    vaults: Vec<VaultInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultList {
    pub active: String,
    pub vaults: Vec<VaultInfo>,
}

fn registry_path(app_data: &Path) -> PathBuf {
    app_data.join("vaults.json")
}

fn vaults_root(app_data: &Path) -> PathBuf {
    app_data.join("vaults")
}

fn vault_path(app_data: &Path, id: &str) -> PathBuf {
    vaults_root(app_data).join(id)
}

fn load_or_migrate(app_data: &Path) -> Result<Registry, String> {
    let path = registry_path(app_data);
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|err| format!("read vaults: {err}"))?;
        let mut registry: Registry =
            serde_json::from_str(&raw).map_err(|err| format!("parse vaults: {err}"))?;
        if registry.vaults.is_empty() {
            return Err("no vaults configured".into());
        }
        if !registry.vaults.iter().any(|v| v.id == registry.active) {
            registry.active = registry.vaults[0].id.clone();
            save(app_data, &registry)?;
        }
        for vault in &registry.vaults {
            vault::ensure_vault(&vault_path(app_data, &vault.id))?;
        }
        return Ok(registry);
    }

    fs::create_dir_all(app_data).map_err(|err| format!("create app data: {err}"))?;
    let root = vaults_root(app_data);
    fs::create_dir_all(&root).map_err(|err| format!("create vaults root: {err}"))?;

    let legacy = app_data.join("vault");
    let default_id = "default".to_string();
    let default_dir = vault_path(app_data, &default_id);
    if legacy.is_dir() && !default_dir.exists() {
        fs::rename(&legacy, &default_dir).map_err(|err| format!("migrate vault: {err}"))?;
    } else {
        vault::ensure_vault(&default_dir)?;
    }

    let registry = Registry {
        active: default_id.clone(),
        vaults: vec![VaultInfo {
            id: default_id,
            name: "Personal".into(),
        }],
    };
    save(app_data, &registry)?;
    Ok(registry)
}

fn save(app_data: &Path, registry: &Registry) -> Result<(), String> {
    fs::create_dir_all(app_data).map_err(|err| format!("create app data: {err}"))?;
    let raw = serde_json::to_string_pretty(registry).map_err(|err| format!("encode vaults: {err}"))?;
    let path = registry_path(app_data);
    let tmp = app_data.join(format!(
        "vaults.tmp-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::write(&tmp, raw).map_err(|err| format!("write vaults: {err}"))?;
    fs::rename(&tmp, &path).map_err(|err| format!("commit vaults: {err}"))?;
    Ok(())
}

fn new_id(registry: &Registry) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut id = format!("v{stamp}");
    let mut n = 1u32;
    while registry.vaults.iter().any(|v| v.id == id) {
        id = format!("v{stamp}-{n}");
        n += 1;
    }
    id
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("vault name is empty".into());
    }
    if name.chars().count() > 48 {
        return Err("vault name is too long".into());
    }
    Ok(name.to_string())
}

pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| err.to_string())
}

pub fn active_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app_data_dir(app)?;
    let registry = load_or_migrate(&app_data)?;
    let dir = vault_path(&app_data, &registry.active);
    vault::ensure_vault(&dir)?;
    Ok(dir)
}

pub fn list(app: &tauri::AppHandle) -> Result<VaultList, String> {
    let app_data = app_data_dir(app)?;
    let registry = load_or_migrate(&app_data)?;
    Ok(VaultList {
        active: registry.active,
        vaults: registry.vaults,
    })
}

pub fn create(app: &tauri::AppHandle, name: String) -> Result<VaultList, String> {
    let name = clean_name(&name)?;
    let app_data = app_data_dir(app)?;
    let mut registry = load_or_migrate(&app_data)?;
    let id = new_id(&registry);
    let dir = vault_path(&app_data, &id);
    vault::ensure_vault(&dir)?;
    registry.vaults.push(VaultInfo { id: id.clone(), name });
    registry.active = id;
    save(&app_data, &registry)?;
    Ok(VaultList {
        active: registry.active,
        vaults: registry.vaults,
    })
}

pub fn switch(app: &tauri::AppHandle, id: String) -> Result<VaultList, String> {
    let app_data = app_data_dir(app)?;
    let mut registry = load_or_migrate(&app_data)?;
    if !registry.vaults.iter().any(|v| v.id == id) {
        return Err("vault not found".into());
    }
    registry.active = id;
    save(&app_data, &registry)?;
    let dir = vault_path(&app_data, &registry.active);
    vault::ensure_vault(&dir)?;
    Ok(VaultList {
        active: registry.active,
        vaults: registry.vaults,
    })
}

pub fn rename(app: &tauri::AppHandle, id: String, name: String) -> Result<VaultList, String> {
    let name = clean_name(&name)?;
    let app_data = app_data_dir(app)?;
    let mut registry = load_or_migrate(&app_data)?;
    let vault = registry
        .vaults
        .iter_mut()
        .find(|v| v.id == id)
        .ok_or_else(|| "vault not found".to_string())?;
    vault.name = name;
    save(&app_data, &registry)?;
    Ok(VaultList {
        active: registry.active,
        vaults: registry.vaults,
    })
}

pub fn delete(app: &tauri::AppHandle, id: String) -> Result<VaultList, String> {
    let app_data = app_data_dir(app)?;
    let mut registry = load_or_migrate(&app_data)?;
    if registry.vaults.len() <= 1 {
        return Err("keep at least one vault".into());
    }
    if !registry.vaults.iter().any(|v| v.id == id) {
        return Err("vault not found".into());
    }
    registry.vaults.retain(|v| v.id != id);
    if registry.active == id {
        registry.active = registry.vaults[0].id.clone();
    }
    save(&app_data, &registry)?;
    let dir = vault_path(&app_data, &id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|err| format!("delete vault files: {err}"))?;
    }
    let active = vault_path(&app_data, &registry.active);
    vault::ensure_vault(&active)?;
    Ok(VaultList {
        active: registry.active,
        vaults: registry.vaults,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_legacy_vault_and_create_second() {
        let root = std::env::temp_dir().join(format!(
            "notes-vaults-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let legacy = root.join("vault");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("Hello.md"), "# hi\n").unwrap();

        let registry = load_or_migrate(&root).unwrap();
        assert_eq!(registry.active, "default");
        assert_eq!(registry.vaults.len(), 1);
        assert!(!legacy.exists());
        assert!(vault_path(&root, "default").join("Hello.md").exists());

        let id = new_id(&registry);
        let work = vault_path(&root, &id);
        vault::ensure_vault(&work).unwrap();
        assert!(work.join("Welcome.md").exists());
        assert!(!work.join("Hello.md").exists());

        let _ = fs::remove_dir_all(&root);
    }
}
