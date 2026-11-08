mod crypto;
mod sync;
mod vault;
mod vaults;

fn vault_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    vaults::active_dir(app)
}

#[tauri::command]
fn vault_path(app: tauri::AppHandle) -> Result<String, String> {
    vault_dir(&app).map(|dir| dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_vaults(app: tauri::AppHandle) -> Result<vaults::VaultList, String> {
    vaults::list(&app)
}

#[tauri::command]
fn create_vault(app: tauri::AppHandle, name: String) -> Result<vaults::VaultList, String> {
    vaults::create(&app, name)
}

#[tauri::command]
fn switch_vault(app: tauri::AppHandle, id: String) -> Result<vaults::VaultList, String> {
    vaults::switch(&app, id)
}

#[tauri::command]
fn rename_vault(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<vaults::VaultList, String> {
    vaults::rename(&app, id, name)
}

#[tauri::command]
fn delete_vault(app: tauri::AppHandle, id: String) -> Result<vaults::VaultList, String> {
    vaults::delete(&app, id)
}

#[tauri::command]
fn list_notes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    vault::list_notes(&vault_dir(&app)?)
}

#[tauri::command]
fn read_note(app: tauri::AppHandle, path: String) -> Result<String, String> {
    vault::read_note(&vault_dir(&app)?, &path)
}

#[tauri::command]
fn write_note(app: tauri::AppHandle, path: String, body: String) -> Result<(), String> {
    vault::write_note(&vault_dir(&app)?, &path, &body)
}

#[tauri::command]
fn create_note(app: tauri::AppHandle, path: String) -> Result<String, String> {
    vault::create_note(&vault_dir(&app)?, &path)
}

#[tauri::command]
fn rename_note(app: tauri::AppHandle, from: String, to: String) -> Result<String, String> {
    vault::rename_note(&vault_dir(&app)?, &from, &to)
}

#[tauri::command]
fn delete_note(app: tauri::AppHandle, path: String) -> Result<(), String> {
    vault::delete_note(&vault_dir(&app)?, &path)
}

#[tauri::command]
fn get_sync_config(app: tauri::AppHandle) -> Result<Option<sync::SyncConfig>, String> {
    sync::load_config(&vault_dir(&app)?)
}

#[tauri::command]
fn save_sync_config(app: tauri::AppHandle, config: sync::SyncConfig) -> Result<(), String> {
    sync::save_config(&vault_dir(&app)?, &config)
}

#[tauri::command]
fn sync_vault(app: tauri::AppHandle) -> Result<sync::SyncReport, String> {
    sync::run_sync(&vault_dir(&app)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            vault_path,
            list_vaults,
            create_vault,
            switch_vault,
            rename_vault,
            delete_vault,
            list_notes,
            read_note,
            write_note,
            create_note,
            rename_note,
            delete_note,
            get_sync_config,
            save_sync_config,
            sync_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
