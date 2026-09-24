//! Data locations (backend §2.1). The data folder can be moved; its location is
//! kept in a small pointer file inside Tauri's per-OS app data directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

const POINTER: &str = "location.json";

#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub db: PathBuf,
    pub library: PathBuf,
    pub backups: PathBuf,
    pub logs: PathBuf,
}

impl Paths {
    pub fn from_data_dir(dir: &Path) -> Self {
        Self {
            data_dir: dir.to_path_buf(),
            db: dir.join("app.db"),
            library: dir.join("library"),
            backups: dir.join("backups"),
            logs: dir.join("logs"),
        }
    }

    pub fn ensure(&self) -> AppResult<()> {
        for d in [&self.data_dir, &self.library, &self.backups, &self.logs] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct Pointer {
    data_dir: PathBuf,
}

/// The active data folder: the pointer's target when it exists, else the default.
pub fn resolve(app_data_dir: &Path) -> Paths {
    let pointer = app_data_dir.join(POINTER);
    let custom = std::fs::read_to_string(&pointer)
        .ok()
        .and_then(|s| serde_json::from_str::<Pointer>(&s).ok())
        .map(|p| p.data_dir)
        .filter(|d| d.join("app.db").exists());
    Paths::from_data_dir(custom.as_deref().unwrap_or(app_data_dir))
}

pub fn write_pointer(app_data_dir: &Path, data_dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(app_data_dir)?;
    let p = Pointer { data_dir: data_dir.to_path_buf() };
    std::fs::write(app_data_dir.join(POINTER), serde_json::to_string_pretty(&p)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_resolution() {
        let base = tempfile::tempdir().unwrap();
        assert_eq!(resolve(base.path()).data_dir, base.path());
        let other = tempfile::tempdir().unwrap();
        write_pointer(base.path(), other.path()).unwrap();
        // Pointer ignored until the target actually holds a database.
        assert_eq!(resolve(base.path()).data_dir, base.path());
        std::fs::write(other.path().join("app.db"), b"").unwrap();
        assert_eq!(resolve(base.path()).data_dir, other.path());
    }
}
