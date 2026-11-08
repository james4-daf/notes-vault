use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const WELCOME: &str = "\
# Welcome

This vault is a folder of markdown files.

Create a note from the sidebar. A path like `work/todo.md` puts the note in a folder.
";

pub fn ensure_vault(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        if !dir.is_dir() {
            return Err("vault path is not a directory".into());
        }
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|err| format!("create vault: {err}"))?;
    fs::write(dir.join("Welcome.md"), WELCOME).map_err(|err| format!("seed vault: {err}"))?;
    Ok(())
}

pub fn list_notes(vault: &Path) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    walk(vault, vault, &mut notes)?;
    notes.sort();
    Ok(notes)
}

pub fn read_note(vault: &Path, rel: &str) -> Result<String, String> {
    let path = resolve_existing(vault, rel)?;
    fs::read_to_string(&path).map_err(|err| format!("read note: {err}"))
}

pub fn write_note(vault: &Path, rel: &str, body: &str) -> Result<(), String> {
    let path = resolve_existing(vault, rel)?;
    atomic_write(&path, body)
}

pub fn create_note(vault: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize(rel)?;
    let path = vault.join(&rel);
    ensure_parent(vault, &path)?;
    if path.exists() {
        return Err("note already exists".into());
    }
    atomic_write(&path, "")?;
    Ok(rel)
}

pub fn rename_note(vault: &Path, from: &str, to: &str) -> Result<String, String> {
    let from_rel = normalize(from)?;
    let to_rel = normalize(to)?;
    if from_rel == to_rel {
        return Ok(to_rel);
    }
    let src = resolve_existing(vault, &from_rel)?;
    let dest = vault.join(&to_rel);
    ensure_parent(vault, &dest)?;
    if dest.exists() {
        return Err("a note already has that path".into());
    }
    fs::rename(&src, &dest).map_err(|err| format!("rename note: {err}"))?;
    prune_empty_parents(vault, src.parent());
    Ok(to_rel)
}

pub fn delete_note(vault: &Path, rel: &str) -> Result<(), String> {
    let path = resolve_existing(vault, rel)?;
    let parent = path.parent().map(Path::to_path_buf);
    fs::remove_file(&path).map_err(|err| format!("delete note: {err}"))?;
    prune_empty_parents(vault, parent.as_deref());
    Ok(())
}

fn walk(vault: &Path, dir: &Path, notes: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| format!("list notes: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("list notes: {err}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|err| format!("list notes: {err}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            walk(vault, &path, notes)?;
        } else if file_type.is_file() && name.to_ascii_lowercase().ends_with(".md") {
            let rel = path
                .strip_prefix(vault)
                .map_err(|err| format!("list notes: {err}"))?;
            notes.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

fn normalize(rel: &str) -> Result<String, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("path is empty".into());
    }
    let mut parts = Vec::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.starts_with('.') {
            return Err("invalid path".into());
        }
        if part.contains('\0') {
            return Err("invalid path".into());
        }
        parts.push(part);
    }
    let name = parts[parts.len() - 1];
    if !name.to_ascii_lowercase().ends_with(".md") || name.eq_ignore_ascii_case(".md") {
        return Err("notes must end in .md".into());
    }
    Ok(parts.join("/"))
}

fn resolve_existing(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = normalize(rel)?;
    let path = vault.join(&rel);
    let canon_vault = vault
        .canonicalize()
        .map_err(|err| format!("open vault: {err}"))?;
    let canon = path
        .canonicalize()
        .map_err(|_| "note not found".to_string())?;
    if !canon.starts_with(&canon_vault) {
        return Err("invalid path".into());
    }
    if !canon.is_file() {
        return Err("note not found".into());
    }
    Ok(canon)
}

fn ensure_parent(vault: &Path, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid path")?;
    fs::create_dir_all(parent).map_err(|err| format!("create folder: {err}"))?;
    let canon_vault = vault
        .canonicalize()
        .map_err(|err| format!("open vault: {err}"))?;
    let canon_parent = parent
        .canonicalize()
        .map_err(|err| format!("create folder: {err}"))?;
    if !canon_parent.starts_with(&canon_vault) {
        return Err("invalid path".into());
    }
    Ok(())
}

fn atomic_write(path: &Path, body: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid path")?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("save note: {err}"))?
        .as_nanos();
    let tmp = parent.join(format!(".tmp-{}-{nanos}.md", std::process::id()));
    fs::write(&tmp, body).map_err(|err| format!("save note: {err}"))?;
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("save note: {err}"));
    }
    Ok(())
}

fn prune_empty_parents(vault: &Path, start: Option<&Path>) {
    let mut current = start;
    while let Some(dir) = current {
        if dir == vault {
            break;
        }
        let empty = fs::read_dir(dir)
            .ok()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            break;
        }
        if fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_round_trip_and_reject_escape() {
        let dir = std::env::temp_dir().join(format!(
            "notes-vault-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let result = (|| -> Result<(), String> {
            assert_eq!(create_note(&dir, "work/todo.md")?, "work/todo.md");
            write_note(&dir, "work/todo.md", "# Todo\n\n- milk\n")?;
            assert_eq!(list_notes(&dir)?, vec!["work/todo.md".to_string()]);
            assert_eq!(read_note(&dir, "work/todo.md")?, "# Todo\n\n- milk\n");
            fs::write(dir.join("notes.txt"), "nope").unwrap();
            assert_eq!(list_notes(&dir)?, vec!["work/todo.md".to_string()]);

            assert_eq!(rename_note(&dir, "work/todo.md", "later.md")?, "later.md");
            assert!(!dir.join("work").exists());
            delete_note(&dir, "later.md")?;
            assert!(list_notes(&dir)?.is_empty());

            assert!(create_note(&dir, "../secret.md").is_err());
            assert!(create_note(&dir, "/tmp/secret.md").is_err());
            assert!(create_note(&dir, "foo/../../x.md").is_err());
            assert!(write_note(&dir, "missing.md", "x").is_err());
            Ok(())
        })();

        let _ = fs::remove_dir_all(&dir);
        result.unwrap();
    }
}
