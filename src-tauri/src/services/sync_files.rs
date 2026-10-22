//! File sync (docs/sync-design.md): lesson images and library files travel as
//! `files/<sha256>` in the sync repo. The name is the content hash, so two PCs
//! adding the same picture write the same file and never conflict. Rows say
//! which file they need (`file_path` + `sha256`); this module only moves bytes.

use std::path::{Component, Path};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::AppResult;

/// GitHub rejects files over 100 MB; stay well below so pushes stay quick.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct FileRef {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct FilesReport {
    pub uploaded: usize,
    pub downloaded: usize,
    /// Too big to sync, or the bytes don't match the hash the row promises.
    pub skipped: usize,
}

/// Every file the journal's rows point at.
pub fn list_refs(conn: &Connection) -> AppResult<Vec<FileRef>> {
    let mut st = conn.prepare(
        "SELECT a.file_path, a.sha256 FROM lesson_assets a WHERE a.sha256 IS NOT NULL
         UNION
         SELECT r.file_path, r.sha256 FROM resources r
          WHERE r.file_path IS NOT NULL AND r.sha256 IS NOT NULL AND r.deleted_at IS NULL",
    )?;
    let rows = st.query_map([], |r| Ok(FileRef { path: r.get(0)?, sha256: r.get(1)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Paths come from another PC, so they must stay inside the library folder.
fn is_safe_rel(p: &str) -> bool {
    !p.is_empty()
        && !p.contains('\\')
        && !p.contains(':')
        && Path::new(p).components().all(|c| matches!(c, Component::Normal(_)))
}

fn hash_of(path: &Path) -> Option<String> {
    Some(hex::encode(Sha256::digest(std::fs::read(path).ok()?)))
}

/// Uploads files only this PC has, downloads files only the repo has.
/// Never overwrites an existing file, and never trusts bytes that don't match their hash.
pub fn exchange(refs: &[FileRef], library: &Path, repo: &Path) -> AppResult<FilesReport> {
    let store = repo.join("files");
    let mut report = FilesReport::default();
    for r in refs {
        if !is_sha(&r.sha256) || !is_safe_rel(&r.path) {
            report.skipped += 1;
            continue;
        }
        let local = library.join(&r.path);
        let blob = store.join(&r.sha256);
        match (local.is_file(), blob.is_file()) {
            (true, false) => {
                let size = std::fs::metadata(&local)?.len();
                if size > MAX_FILE_BYTES || hash_of(&local).as_deref() != Some(r.sha256.as_str()) {
                    report.skipped += 1;
                    continue;
                }
                std::fs::create_dir_all(&store)?;
                std::fs::copy(&local, &blob)?;
                report.uploaded += 1;
            }
            (false, true) => {
                if hash_of(&blob).as_deref() != Some(r.sha256.as_str()) {
                    report.skipped += 1;
                    continue;
                }
                if let Some(parent) = local.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&blob, &local)?;
                report.downloaded += 1;
            }
            _ => {}
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn write(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    #[test]
    fn a_file_goes_up_from_one_pc_and_down_to_the_other() {
        let (lib_a, lib_b, repo) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        write(lib_a.path(), "lessons/2026/10/a.png", b"picture");
        let r = FileRef { path: "lessons/2026/10/a.png".into(), sha256: sha(b"picture") };

        let up = exchange(&[r.clone()], lib_a.path(), repo.path()).unwrap();
        assert_eq!((up.uploaded, up.downloaded), (1, 0));
        assert!(repo.path().join("files").join(&r.sha256).is_file());

        let down = exchange(&[r.clone()], lib_b.path(), repo.path()).unwrap();
        assert_eq!((down.uploaded, down.downloaded), (0, 1));
        assert_eq!(std::fs::read(lib_b.path().join(&r.path)).unwrap(), b"picture");

        // Nothing left to do, and nothing is overwritten.
        assert_eq!(exchange(&[r], lib_b.path(), repo.path()).unwrap(), FilesReport::default());
    }

    #[test]
    fn bytes_that_do_not_match_the_hash_are_never_used() {
        let (lib, repo) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let r = FileRef { path: "lessons/x.png".into(), sha256: sha(b"expected") };
        write(repo.path(), &format!("files/{}", r.sha256), b"tampered");
        let rep = exchange(&[r.clone()], lib.path(), repo.path()).unwrap();
        assert_eq!((rep.downloaded, rep.skipped), (0, 1));
        assert!(!lib.path().join("lessons/x.png").exists());

        // A local file that isn't what its row says is not published either.
        let (lib2, repo2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        write(lib2.path(), "lessons/x.png", b"something else");
        let rep = exchange(&[r], lib2.path(), repo2.path()).unwrap();
        assert_eq!((rep.uploaded, rep.skipped), (0, 1));
    }

    #[test]
    fn paths_cannot_escape_the_library() {
        let (lib, repo) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let s = sha(b"x");
        write(repo.path(), &format!("files/{s}"), b"x");
        for bad in ["../evil.txt", "/abs.txt", "C:/abs.txt", "a\\b.txt", "", "lessons/../../evil.txt"] {
            let rep = exchange(&[FileRef { path: bad.into(), sha256: s.clone() }], lib.path(), repo.path()).unwrap();
            assert_eq!((rep.downloaded, rep.skipped), (0, 1), "{bad}");
        }
        assert!(!lib.path().parent().unwrap().join("evil.txt").exists());
    }

    #[test]
    fn rows_name_the_files_they_need() {
        let c = crate::db::open_in_memory().unwrap();
        c.execute_batch(
            "INSERT INTO resources(id,kind,title,file_path,sha256,created_at,updated_at)
               VALUES ('r1','image','pic','library/a.png','aa','t','t');
             INSERT INTO resources(id,kind,title,created_at,updated_at) VALUES ('r2','link','no file','t','t');",
        )
        .unwrap();
        let refs = list_refs(&c).unwrap();
        assert_eq!(refs, vec![FileRef { path: "library/a.png".into(), sha256: "aa".into() }]);
    }
}
