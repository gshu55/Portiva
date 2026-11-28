//! Native 2.x updates use GitHub Releases, independently of the legacy Tauri manifest.
use anyhow::{Context as _, Result, bail, ensure};
use reqwest::Client;
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::{io::AsyncWriteExt, sync::watch};

pub const RELEASES_URL: &str = "https://github.com/gshu55/Portiva/releases";
const MANIFEST_URL: &str =
    "https://github.com/gshu55/Portiva/releases/latest/download/update-v2.json";
const DOWNLOAD_URL: &str = "https://github.com/gshu55/Portiva/releases/download";
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    WindowsX64,
    LinuxAmd64,
    LinuxArm64,
    MacosArm64,
}

impl Platform {
    pub fn current() -> Result<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => Ok(Self::WindowsX64),
            ("linux", "x86_64") => Ok(Self::LinuxAmd64),
            ("linux", "aarch64") => Ok(Self::LinuxArm64),
            ("macos", "aarch64") => Ok(Self::MacosArm64),
            _ => bail!("当前平台没有官方更新包，请查看 GitHub Releases"),
        }
    }

    fn suffix(self, package: bool) -> &'static str {
        match (self, package) {
            (Self::WindowsX64, _) => "windows_x64.zip",
            (Self::LinuxAmd64, false) => "linux_amd64.tar.gz",
            (Self::LinuxArm64, false) => "linux_arm64.tar.gz",
            (Self::LinuxAmd64, true) => "linux_amd64.deb",
            (Self::LinuxArm64, true) => "linux_arm64.deb",
            (Self::MacosArm64, _) => "macos_arm64.dmg",
        }
    }
}

#[derive(Clone, Debug)]
enum InstallMode {
    ReplaceBinary(PathBuf),
    Package,
}

impl InstallMode {
    fn detect(platform: Platform) -> Result<Self> {
        if platform == Platform::MacosArm64 {
            return Ok(Self::Package);
        }
        let target = dunce::canonicalize(std::env::current_exe()?)?;
        let parent = target.parent().context("找不到应用目录")?;
        // A distro-managed binary must be upgraded by the package manager.
        if matches!(platform, Platform::LinuxAmd64 | Platform::LinuxArm64)
            && (target.starts_with("/usr") || tempfile::tempfile_in(parent).is_err())
        {
            return Ok(Self::Package);
        }
        tempfile::tempfile_in(parent).context("应用目录不可写，请将程序移到可写目录后更新")?;
        ensure!(
            !fs::metadata(&target)?.permissions().readonly(),
            "应用文件只读，请修改权限后更新"
        );
        Ok(Self::ReplaceBinary(target))
    }
}

#[derive(Clone, Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Clone, Debug)]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: String,
    asset: Asset,
    checksums: Asset,
    checksum: String,
    platform: Platform,
    mode: InstallMode,
}

impl AvailableUpdate {
    pub fn size(&self) -> u64 {
        self.asset.size
    }

    pub fn requires_restart(&self) -> bool {
        matches!(self.mode, InstallMode::ReplaceBinary(_))
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Clone)]
pub struct GithubUpdater {
    client: Client,
}

impl GithubUpdater {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .user_agent(concat!("Portiva/", env!("CARGO_PKG_VERSION")))
                .https_only(true)
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()?,
        })
    }

    pub async fn check(&self) -> Result<Option<AvailableUpdate>> {
        let platform = Platform::current()?;
        let response = self
            .client
            .get(MANIFEST_URL)
            .header("Accept", "application/json")
            .send()
            .await
            .context("无法连接 GitHub，请检查网络或代理")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let json = limited_body(
            response
                .error_for_status()
                .context("无法读取 GitHub 更新清单，请检查网络或代理")?,
            2 * 1024 * 1024,
        )
        .await?;
        // Detect permissions only when an update is actually available.
        let mut update = parse_release(
            &json,
            env!("CARGO_PKG_VERSION"),
            platform,
            InstallMode::Package,
        )?;
        if update.is_none() {
            return Ok(None);
        }
        let mode = InstallMode::detect(platform)?;
        update = parse_release(&json, env!("CARGO_PKG_VERSION"), platform, mode)?;
        let update = update.as_mut().context("更新版本发生变化")?;
        let response = self
            .client
            .get(&update.checksums.browser_download_url)
            .send()
            .await?
            .error_for_status()?;
        let sums = limited_body(response, 64 * 1024).await?;
        update.checksum = checksum_for(std::str::from_utf8(&sums)?, &update.asset.name)?;
        Ok(Some(update.clone()))
    }

    pub async fn download(
        &self,
        update: AvailableUpdate,
        data: PathBuf,
        progress: watch::Sender<DownloadProgress>,
    ) -> Result<DownloadedUpdate> {
        let cache = data.join("updates");
        tokio::fs::create_dir_all(&cache).await?;
        let directory = tempfile::Builder::new()
            .prefix("update-")
            .tempdir_in(cache)?;
        let archive = directory.path().join(&update.asset.name);
        let mut response = self
            .client
            .get(&update.asset.browser_download_url)
            .send()
            .await
            .context("下载 GitHub 更新包失败")?
            .error_for_status()?;
        if let Some(length) = response.content_length() {
            ensure!(
                length == update.asset.size,
                "下载包大小与 GitHub 发布记录不一致"
            );
        }
        let mut output = tokio::fs::File::create(&archive).await?;
        let mut hash = Sha256::new();
        let mut downloaded = 0;
        let mut last_progress = Instant::now();
        while let Some(chunk) = response.chunk().await? {
            downloaded += chunk.len() as u64;
            ensure!(
                downloaded <= update.asset.size,
                "更新包超过预期大小，下载已停止"
            );
            hash.update(&chunk);
            output.write_all(&chunk).await?;
            if last_progress.elapsed() >= Duration::from_millis(100) {
                progress.send_replace(DownloadProgress {
                    downloaded,
                    total: update.asset.size,
                });
                last_progress = Instant::now();
            }
        }
        output.flush().await?;
        drop(output);
        verify_download(
            downloaded,
            update.asset.size,
            &format!("{:x}", hash.finalize()),
            &update.checksum,
        )?;
        progress.send_replace(DownloadProgress {
            downloaded,
            total: update.asset.size,
        });
        tokio::task::spawn_blocking(move || {
            let payload = match update.mode {
                InstallMode::Package => archive,
                InstallMode::ReplaceBinary(_) => {
                    extract_binary(&archive, directory.path(), &update)?
                }
            };
            Ok(DownloadedUpdate {
                directory,
                payload,
                mode: update.mode,
                version: update.version,
            })
        })
        .await?
    }
}

async fn limited_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(bytes.len() + chunk.len() <= limit, "GitHub 返回的数据过大");
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_release(
    json: &[u8],
    current: &str,
    platform: Platform,
    mode: InstallMode,
) -> Result<Option<AvailableUpdate>> {
    let release: GithubRelease = serde_json::from_slice(json).context("GitHub 发布数据格式错误")?;
    let version = Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .context("发布标签缺少 v 前缀")?,
    )?;
    if release.draft
        || release.prerelease
        || !version.pre.is_empty()
        || version.major != 2
        || !version.cmp_precedence(&Version::parse(current)?).is_gt()
    {
        return Ok(None);
    }
    ensure!(
        release.tag_name == format!("v{version}"),
        "发布标签格式无效"
    );
    let name = format!(
        "Portiva_{version}_{}",
        platform.suffix(matches!(mode, InstallMode::Package))
    );
    let asset = find_asset(&release.assets, &release.tag_name, &name)?;
    let checksums = find_asset(&release.assets, &release.tag_name, "SHA256SUMS.txt")?;
    ensure!(checksums.size <= 64 * 1024, "SHA-256 清单过大");
    Ok(Some(AvailableUpdate {
        version: version.to_string(),
        notes: release.body.unwrap_or_default(),
        asset,
        checksums,
        checksum: String::new(),
        platform,
        mode,
    }))
}

fn find_asset(assets: &[Asset], tag: &str, name: &str) -> Result<Asset> {
    let matches: Vec<_> = assets.iter().filter(|asset| asset.name == name).collect();
    ensure!(matches.len() == 1, "GitHub 发布缺少唯一附件：{name}");
    let asset = matches[0];
    ensure!(
        asset.browser_download_url == format!("{DOWNLOAD_URL}/{tag}/{name}"),
        "更新附件必须来自 gshu55/Portiva 的对应 GitHub Release"
    );
    ensure!(
        asset.size > 0 && asset.size <= MAX_DOWNLOAD,
        "更新附件大小无效"
    );
    Ok(asset.clone())
}

fn checksum_for(sums: &str, name: &str) -> Result<String> {
    let mut found = None;
    for line in sums.lines() {
        if let Some((hash, filename)) = line.split_once("  ")
            && filename == name
        {
            ensure!(found.is_none(), "SHA-256 清单包含重复附件");
            ensure!(
                hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
                "SHA-256 格式无效"
            );
            found = Some(hash.to_ascii_lowercase());
        }
    }
    found.context("SHA-256 清单缺少当前平台附件")
}

fn verify_download(size: u64, expected: u64, hash: &str, checksum: &str) -> Result<()> {
    ensure!(size == expected, "更新包下载不完整，请重试");
    ensure!(hash == checksum, "更新包 SHA-256 校验失败，请重新下载");
    Ok(())
}

fn extract_binary(archive: &Path, directory: &Path, update: &AvailableUpdate) -> Result<PathBuf> {
    let payload = directory.join(if update.platform == Platform::WindowsX64 {
        "portiva2.exe"
    } else {
        "portiva2"
    });
    let mut output = File::create(&payload)?;
    if update.platform == Platform::WindowsX64 {
        let mut zip = zip::ZipArchive::new(File::open(archive)?)?;
        ensure!(
            zip.file_names()
                .filter(|name| *name == "portiva2.exe")
                .count()
                == 1,
            "ZIP 缺少唯一的 portiva2.exe"
        );
        let mut binary = zip.by_name("portiva2.exe")?;
        ensure!(binary.size() <= MAX_DOWNLOAD, "更新程序过大");
        std::io::copy(&mut binary, &mut output)?;
    } else {
        let suffix = update.platform.suffix(false).trim_end_matches(".tar.gz");
        let expected = format!("Portiva_{}_{suffix}/portiva2", update.version);
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
        let mut found = false;
        for entry in tar.entries()? {
            let mut entry = entry?;
            if entry.path()? == Path::new(&expected) {
                ensure!(
                    !found && entry.header().entry_type().is_file(),
                    "TAR 中的更新程序重复或不是普通文件"
                );
                ensure!(entry.size() <= MAX_DOWNLOAD, "更新程序过大");
                std::io::copy(&mut entry, &mut output)?;
                found = true;
            }
        }
        ensure!(found, "TAR 中找不到更新程序");
    }
    output.flush()?;
    drop(output);
    verify_binary(&payload, update.platform)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o755))?;
    }
    Ok(payload)
}

fn verify_binary(path: &Path, platform: Platform) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    let mut file = File::open(path)?;
    let mut header = [0; 64];
    file.read_exact(&mut header).context("更新程序已损坏")?;
    match platform {
        Platform::WindowsX64 => {
            ensure!(&header[..2] == b"MZ", "更新程序不是 Windows 可执行文件");
            file.seek(SeekFrom::Start(
                u32::from_le_bytes(header[60..64].try_into()?) as u64,
            ))?;
            let mut pe = [0; 6];
            file.read_exact(&mut pe)?;
            ensure!(
                &pe[..4] == b"PE\0\0" && u16::from_le_bytes(pe[4..6].try_into()?) == 0x8664,
                "更新程序不是 Windows x64 架构"
            );
        }
        Platform::LinuxAmd64 | Platform::LinuxArm64 => {
            let machine = if platform == Platform::LinuxAmd64 {
                62
            } else {
                183
            };
            ensure!(
                &header[..6] == b"\x7fELF\x02\x01"
                    && u16::from_le_bytes(header[18..20].try_into()?) == machine,
                "更新程序 Linux 架构不匹配"
            );
        }
        Platform::MacosArm64 => bail!("macOS 请通过 DMG 安装完整应用"),
    }
    Ok(())
}

pub struct DownloadedUpdate {
    directory: TempDir,
    payload: PathBuf,
    mode: InstallMode,
    pub version: String,
}

pub enum InstallAction {
    Restart,
    OpenedPackage,
}

impl DownloadedUpdate {
    pub fn requires_restart(&self) -> bool {
        matches!(self.mode, InstallMode::ReplaceBinary(_))
    }

    /// Called only after the user requests installation and closes sessions/transfers.
    pub fn install(self) -> Result<InstallAction> {
        if let InstallMode::ReplaceBinary(target) = &self.mode {
            let parent = target.parent().context("找不到应用目录")?;
            // Prepare on the same filesystem before quitting; replacement is atomic.
            let mut pending = tempfile::Builder::new()
                .prefix(".portiva2-update-")
                .suffix(".tmp")
                .tempfile_in(parent)?;
            std::io::copy(&mut File::open(&self.payload)?, pending.as_file_mut())?;
            pending.as_file_mut().sync_all()?;
            fs::set_permissions(pending.path(), fs::metadata(&self.payload)?.permissions())?;
            let script = self.directory.path().join(if cfg!(windows) {
                "install.ps1"
            } else {
                "install.sh"
            });
            fs::write(
                &script,
                if cfg!(windows) {
                    include_str!("update/install.ps1")
                } else {
                    include_str!("update/install.sh")
                },
            )?;
            let mut command = if cfg!(windows) {
                let mut command = Command::new("powershell.exe");
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-WindowStyle",
                    "Hidden",
                    "-File",
                ]);
                command
            } else {
                Command::new("/bin/sh")
            };
            command
                .arg(&script)
                .arg(pending.path())
                .arg(target)
                .arg(std::process::id().to_string())
                .arg(self.directory.path());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            command
                .spawn()
                .context("无法启动更新安装程序，当前程序保持运行")?;
            let _ = pending.keep()?;
            let _ = self.directory.keep();
            Ok(InstallAction::Restart)
        } else {
            let package = self.payload.clone();
            let _ = self.directory.keep();
            let mut command = Command::new(if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            });
            command.arg(&package).spawn().with_context(|| {
                format!(
                    "无法启动系统安装器，安装包已保存到 {}，请手动安装",
                    package.display()
                )
            })?;
            Ok(InstallAction::OpenedPackage)
        }
    }

    pub fn path(&self) -> &Path {
        &self.payload
    }
}

pub fn last_install_error(data: &Path) -> Option<String> {
    fs::read_dir(data.join("updates"))
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_name().to_string_lossy().starts_with("update-") {
                return None;
            }
            let path = entry.path().join("install-error.txt");
            Some((path.metadata().ok()?.modified().ok()?, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .and_then(|(_, path)| fs::read_to_string(path).ok())
        .map(|error| format!("上次更新未完成，原程序已保留：{}", error.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(version: &str) -> serde_json::Value {
        let tag = format!("v{version}");
        let mut names = vec!["SHA256SUMS.txt".to_owned()];
        for platform in [
            Platform::WindowsX64,
            Platform::LinuxAmd64,
            Platform::LinuxArm64,
            Platform::MacosArm64,
        ] {
            for package in [false, true] {
                let name = format!("Portiva_{version}_{}", platform.suffix(package));
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
        json!({"tag_name":tag,"draft":false,"prerelease":false,"body":"Release notes","assets": names.into_iter().map(|name| json!({"browser_download_url":format!("{DOWNLOAD_URL}/{tag}/{name}"),"name":name,"size":100})).collect::<Vec<_>>()})
    }

    fn parse(
        value: &serde_json::Value,
        platform: Platform,
        package: bool,
    ) -> Result<Option<AvailableUpdate>> {
        parse_release(
            &serde_json::to_vec(value)?,
            "2.0.0",
            platform,
            if package {
                InstallMode::Package
            } else {
                InstallMode::ReplaceBinary("portiva2".into())
            },
        )
    }

    #[test]
    fn selects_all_native_architectures_and_installer_modes() -> Result<()> {
        for platform in [
            Platform::WindowsX64,
            Platform::LinuxAmd64,
            Platform::LinuxArm64,
            Platform::MacosArm64,
        ] {
            for package in [false, true] {
                let update = parse(&release("2.1.0"), platform, package)?.unwrap();
                assert!(update.asset.name.ends_with(platform.suffix(package)));
                assert_eq!(update.version, "2.1.0");
            }
        }
        Ok(())
    }

    #[test]
    fn refuses_downgrades_other_majors_and_unstable_releases() -> Result<()> {
        for version in ["1.15.1", "2.0.0", "2.0.0+build", "2.1.0-beta.1", "3.0.0"] {
            assert!(parse(&release(version), Platform::WindowsX64, false)?.is_none());
        }
        for flag in ["draft", "prerelease"] {
            let mut value = release("2.1.0");
            value[flag] = true.into();
            assert!(parse(&value, Platform::WindowsX64, false)?.is_none());
        }
        Ok(())
    }

    #[test]
    fn rejects_missing_duplicate_foreign_and_oversized_assets() -> Result<()> {
        for mutation in 0..4 {
            let mut value = release("2.1.0");
            let assets = value["assets"].as_array_mut().unwrap();
            match mutation {
                0 => {
                    assets.remove(1);
                }
                1 => assets.push(assets[1].clone()),
                2 => assets[1]["browser_download_url"] = "https://example.com/portiva2.zip".into(),
                _ => assets[1]["size"] = (MAX_DOWNLOAD + 1).into(),
            }
            assert!(parse(&value, Platform::WindowsX64, false).is_err());
        }
        Ok(())
    }

    #[test]
    fn checksums_require_exact_names_unique_entries_and_complete_downloads() -> Result<()> {
        let hash = format!("{:x}", Sha256::digest(b"update"));
        let sums = format!("{hash}  portiva2.zip\n");
        assert_eq!(checksum_for(&sums, "portiva2.zip")?, hash);
        assert!(checksum_for(&sums, "portiva2").is_err());
        assert!(checksum_for(&sums.repeat(2), "portiva2.zip").is_err());
        assert!(checksum_for("bad  portiva2.zip", "portiva2.zip").is_err());
        assert!(verify_download(6, 6, &hash, &hash).is_ok());
        assert!(verify_download(5, 6, &hash, &hash).is_err());
        assert!(verify_download(6, 6, &hash, &"0".repeat(64)).is_err());
        Ok(())
    }

    #[tokio::test]
    async fn streams_downloads_and_rejects_corruption_and_truncation() -> Result<()> {
        use tokio::io::AsyncReadExt;
        for (body, expected_size, expected_hash) in [
            (b"update".as_slice(), 6, Sha256::digest(b"update")),
            (b"broken".as_slice(), 6, Sha256::digest(b"update")),
            (b"short".as_slice(), 6, Sha256::digest(b"update")),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let url = format!("http://{}/fixture", listener.local_addr()?);
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await?;
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let count = stream.read(&mut chunk).await?;
                    ensure!(
                        count > 0 && request.len() + count < 16 * 1024,
                        "invalid test request"
                    );
                    request.extend_from_slice(&chunk[..count]);
                }
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {expected_size}\r\nConnection: close\r\n\r\n").as_bytes()).await?;
                stream.write_all(body).await?;
                Ok::<_, anyhow::Error>(())
            });
            let mut update = parse(&release("2.1.0"), Platform::MacosArm64, true)?.unwrap();
            update.asset.size = expected_size;
            update.asset.browser_download_url = url;
            update.checksum = format!("{expected_hash:x}");
            let updater = GithubUpdater {
                client: Client::builder().no_proxy().build()?,
            };
            let directory = tempfile::tempdir()?;
            let (progress, received) = watch::channel(DownloadProgress::default());
            let result = updater
                .download(update, directory.path().to_path_buf(), progress)
                .await;
            if body == b"update" {
                let downloaded = result?;
                assert_eq!(fs::read(downloaded.path())?, body);
                assert_eq!(received.borrow().downloaded, 6);
                drop(downloaded);
            } else {
                assert!(result.is_err());
            }
            assert_eq!(
                fs::read_dir(directory.path().join("updates"))?.count(),
                0,
                "failed/unused downloads must be removed"
            );
            server.await??;
        }
        Ok(())
    }

    #[test]
    fn zip_extracts_the_fixed_executable_and_rejects_invalid_pe() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let archive = directory.path().join("update.zip");
        let mut header = vec![0; 70];
        header[..2].copy_from_slice(b"MZ");
        header[60..64].copy_from_slice(&64_u32.to_le_bytes());
        header[64..68].copy_from_slice(b"PE\0\0");
        header[68..70].copy_from_slice(&0x8664_u16.to_le_bytes());
        let mut zip = zip::ZipWriter::new(File::create(&archive)?);
        zip.start_file("portiva2.exe", zip::write::SimpleFileOptions::default())?;
        zip.write_all(&header)?;
        zip.start_file(
            "irrelevant/portiva2.exe",
            zip::write::SimpleFileOptions::default(),
        )?;
        zip.write_all(b"not executable")?;
        zip.finish()?;
        let update = parse(&release("2.1.0"), Platform::WindowsX64, false)?.unwrap();
        let binary = extract_binary(&archive, directory.path(), &update)?;
        assert_eq!(fs::read(&binary)?, header);
        fs::write(&binary, elf(62))?;
        assert!(verify_binary(&binary, Platform::WindowsX64).is_err());
        assert!(!directory.path().join("irrelevant").exists());
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn windows_installer_replaces_atomically_and_rolls_back_launch_errors() -> Result<()> {
        for fail_restart in [false, true] {
            let root = tempfile::tempdir()?;
            let source = root.path().join("replacement.tmp");
            let target = root.path().join("installed fixture.bin");
            let script = root.path().join("install.ps1");
            let marker = root.path().join("restarted");
            fs::write(&source, b"new")?;
            fs::write(&target, b"old")?;
            fs::write(&script, include_str!("update/install.ps1"))?;
            // Substitute only process launching; exercise real File.Replace and rollback.
            let status = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                    "function Start-Process { param($FilePath,$WorkingDirectory,$WindowStyle); if ($env:PORTIVA_TEST_FAIL -eq '1') { throw 'simulated launch failure' }; [IO.File]::WriteAllText($env:PORTIVA_TEST_MARKER, 'restarted') }; & $env:PORTIVA_TEST_SCRIPT $env:PORTIVA_TEST_SOURCE $env:PORTIVA_TEST_TARGET 2147483647 $env:PORTIVA_TEST_CACHE"])
                .env("PORTIVA_TEST_FAIL", if fail_restart { "1" } else { "0" })
                .env("PORTIVA_TEST_MARKER", &marker).env("PORTIVA_TEST_SCRIPT", &script)
                .env("PORTIVA_TEST_SOURCE", &source).env("PORTIVA_TEST_TARGET", &target)
                .env("PORTIVA_TEST_CACHE", root.path()).status()?;
            assert!(status.success());
            assert_eq!(
                fs::read(&target)?,
                if fail_restart { b"old" } else { b"new" }
            );
            assert_eq!(marker.exists(), !fail_restart);
            assert_eq!(root.path().join("install-error.txt").exists(), fail_restart);
            assert!(!source.exists());
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn unix_installer_waits_for_exit_and_restores_failed_restarts() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        for fail_restart in [false, true] {
            let root = tempfile::tempdir()?;
            let source = root.path().join("replacement.tmp");
            let target = root.path().join("installed fixture");
            let script = root.path().join("install.sh");
            let marker = root.path().join("restarted");
            let old = "#!/bin/sh\nexit 0\n";
            fs::write(
                &source,
                if fail_restart {
                    "#!/bin/sh\nexit 1\n"
                } else {
                    "#!/bin/sh\nprintf restarted > \"$PORTIVA_TEST_MARKER\"\nsleep 3\n"
                },
            )?;
            fs::write(&target, old)?;
            for path in [&source, &target] {
                fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
            }
            fs::write(&script, include_str!("update/install.sh"))?;
            let mut parent = Command::new("/bin/sh").args(["-c", "sleep 1"]).spawn()?;
            let mut helper = Command::new("/bin/sh")
                .arg(&script)
                .arg(&source)
                .arg(&target)
                .arg(parent.id().to_string())
                .arg(root.path())
                .env("PORTIVA_TEST_MARKER", &marker)
                .spawn()?;
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(
                fs::read_to_string(&target)?,
                old,
                "must not replace while parent is alive"
            );
            parent.wait()?;
            let status = helper.wait()?;
            assert_eq!(status.success(), !fail_restart);
            assert_eq!(marker.exists(), !fail_restart);
            if fail_restart {
                assert_eq!(fs::read_to_string(&target)?, old);
            }
        }
        Ok(())
    }

    fn elf(machine: u16) -> Vec<u8> {
        let mut header = vec![0; 64];
        header[..6].copy_from_slice(b"\x7fELF\x02\x01");
        header[18..20].copy_from_slice(&machine.to_le_bytes());
        header
    }

    #[test]
    fn extraction_selects_only_expected_binary_and_verifies_architecture() -> Result<()> {
        for (platform, machine) in [(Platform::LinuxAmd64, 62), (Platform::LinuxArm64, 183)] {
            let directory = tempfile::tempdir()?;
            let archive = directory.path().join("update.tar.gz");
            let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
                File::create(&archive)?,
                flate2::Compression::fast(),
            ));
            let header = elf(machine);
            let mut entry = tar::Header::new_gnu();
            entry.set_size(header.len() as u64);
            entry.set_mode(0o755);
            entry.set_cksum();
            let expected = format!(
                "Portiva_2.1.0_{}/portiva2",
                platform.suffix(false).trim_end_matches(".tar.gz")
            );
            builder.append_data(&mut entry, expected, header.as_slice())?;
            builder.into_inner()?.finish()?;
            let update = parse(&release("2.1.0"), platform, false)?.unwrap();
            let binary = extract_binary(&archive, directory.path(), &update)?;
            assert_eq!(fs::read(&binary)?, header);
            assert!(
                verify_binary(
                    &binary,
                    if machine == 62 {
                        Platform::LinuxArm64
                    } else {
                        Platform::LinuxAmd64
                    }
                )
                .is_err()
            );
        }
        Ok(())
    }
}
