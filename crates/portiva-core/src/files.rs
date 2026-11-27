use std::path::{Component, Path};

use crate::{DirectoryListing, FileEntry, FileKind};
use anyhow::{Context, Result, bail};

pub(crate) fn remote_join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

pub(crate) fn validate_name(name: &str) -> Result<()> {
    anyhow::ensure!(
        !name.is_empty() && name != "." && name != "..",
        "文件名不能为空或为 . / .."
    );
    anyhow::ensure!(
        !name.contains(['/', '\\', '\0']) && !name.chars().any(char::is_control),
        "文件名包含非法字符"
    );
    Ok(())
}

/// Remote directory entries are untrusted input. Never let them escape a download root.
pub(crate) fn local_child(parent: &Path, name: &str) -> Result<std::path::PathBuf> {
    validate_name(name)?;
    anyhow::ensure!(
        Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_))),
        "远程名称不是安全的本地文件名"
    );
    #[cfg(windows)]
    {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        anyhow::ensure!(
            !name.contains([':', '*', '?', '"', '<', '>', '|'])
                && !name.ends_with(['.', ' '])
                && !reserved.contains(&stem.as_str()),
            "远程文件名无法安全表示为 Windows 文件名：{name}"
        );
    }
    Ok(parent.join(name))
}

pub(crate) fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.is_symlink()
}

/// Refuse existing links/junctions below the explicitly chosen download directory.
pub(crate) async fn check_download_path(root: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(root).context("下载路径超出了所选目录")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        anyhow::ensure!(
            matches!(component, Component::Normal(_)),
            "下载路径包含非法片段"
        );
        current.push(component);
        match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) => anyhow::ensure!(
                !is_link(&metadata),
                "下载目标包含符号链接或目录联接：{}",
                current.display()
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

pub(crate) async fn local_listing(path: &Path) -> Result<DirectoryListing> {
    let path = tokio::fs::canonicalize(path)
        .await
        .context("本地目录不可访问")?;
    let path = dunce::simplified(&path).to_path_buf();
    let mut reader = tokio::fs::read_dir(&path).await?;
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        let metadata = tokio::fs::symlink_metadata(entry.path()).await?;
        let kind = if is_link(&metadata) {
            FileKind::Symlink
        } else if metadata.is_dir() {
            FileKind::Directory
        } else if metadata.is_file() {
            FileKind::File
        } else {
            FileKind::Other
        };
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            kind,
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|t| t.as_secs()),
            permissions: None,
        });
    }
    sort_entries(&mut entries);
    Ok(DirectoryListing {
        path: path.to_string_lossy().into_owned(),
        entries,
    })
}

pub(crate) fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        (a.kind != FileKind::Directory)
            .cmp(&(b.kind != FileKind::Directory))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub(crate) fn protect_remote_root(path: &str) -> Result<()> {
    if path.trim_matches('/').is_empty()
        || path
            .split('/')
            .all(|p| p.is_empty() || p == "." || p == "..")
    {
        bail!("不能删除或重命名远程根目录");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_names_cannot_escape_local_directory() {
        for name in ["..", ".", "../secret", "/etc/passwd", "a/b", "a\\b", "a\0b"] {
            assert!(
                local_child(Path::new("downloads"), name).is_err(),
                "{name:?}"
            );
        }
        assert_eq!(
            local_child(Path::new("downloads"), "中文.txt").unwrap(),
            Path::new("downloads").join("中文.txt")
        );
    }
}
