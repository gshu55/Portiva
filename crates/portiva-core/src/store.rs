use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result, bail};
use serde::{Serialize, de::DeserializeOwned};

use crate::{AuthMethod, Credentials, Profile, Settings, secrets::SecretStore};

/// Explicit storage location; the core never consults a UI's window or global state.
pub struct Store {
    root: PathBuf,
    operations: Mutex<()>,
    secrets: SecretStore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HostTrust {
    Unknown,
    Trusted,
    Changed(String),
}

impl Store {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)
            .with_context(|| format!("无法创建配置目录 {}", root.display()))?;
        Ok(Self {
            secrets: SecretStore::new(&root)?,
            root,
            operations: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn settings(&self) -> Result<Settings> {
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        let settings: Settings = self.load("settings.json")?;
        settings.validate()?;
        Ok(settings)
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        settings.validate()?;
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        self.save("settings.json", settings)
    }

    /// Blocking OS and disk operations: adapters should call this on a worker thread.
    pub fn save_connection(&self, mut profile: Profile, credentials: &Credentials) -> Result<()> {
        profile.validate()?;
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        let mut profiles: Vec<Profile> = self.load("profiles.json")?;
        let previous = profiles.iter().find(|p| p.id == profile.id).cloned();
        if profile.auth == AuthMethod::Agent {
            profile.remember_secret = false;
        }
        let mut restore = Vec::new();
        if profile.remember_secret {
            restore.push((profile.clone(), self.secrets.get(&profile)?));
        }
        let remove_previous = previous.as_ref().filter(|old| {
            old.remember_secret
                && (!profile.remember_secret
                    || self.secrets.identity(old) != self.secrets.identity(&profile))
        });
        if let Some(old) = remove_previous {
            restore.push((old.clone(), self.secrets.get(old)?));
        }
        let result = (|| -> Result<()> {
            if profile.remember_secret {
                let secret: &str = if profile.auth == AuthMethod::PrivateKey {
                    &credentials.passphrase
                } else {
                    &credentials.password
                };
                if !secret.is_empty() {
                    self.secrets.set(&profile, secret)?;
                } else if self.secrets.get(&profile)?.is_none() {
                    anyhow::ensure!(
                        profile.auth == AuthMethod::PrivateKey,
                        "请先输入要保存的密码"
                    );
                    self.secrets.set(&profile, "")?;
                }
            }
            if let Some(old) = remove_previous {
                self.secrets.delete(old)?;
            }
            profiles.retain(|p| p.id != profile.id);
            profiles.push(profile.clone());
            self.save("profiles.json", &profiles)
        })();
        if let Err(error) = result {
            let mut failures = Vec::new();
            for (profile, secret) in restore {
                let rollback = match secret {
                    Some(secret) => self.secrets.set(&profile, &secret),
                    None => self.secrets.delete(&profile),
                };
                if let Err(rollback) = rollback {
                    failures.push(format!("{rollback:#}"));
                }
            }
            if !failures.is_empty() {
                return Err(error).context(format!("凭据恢复失败：{}", failures.join("；")));
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn resolve_credentials(
        &self,
        profile: &Profile,
        mut credentials: Credentials,
    ) -> Result<Credentials> {
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        if profile.remember_secret && profile.auth != AuthMethod::Agent {
            let target = if profile.auth == AuthMethod::PrivateKey {
                &mut credentials.passphrase
            } else {
                &mut credentials.password
            };
            if target.is_empty() {
                *target = self
                    .secrets
                    .get(profile)?
                    .context("已保存的凭据不存在，请重新输入并保存")?;
            }
        }
        Ok(credentials)
    }

    pub fn forget_secret(&self, id: &str) -> Result<()> {
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        let mut profiles: Vec<Profile> = self.load("profiles.json")?;
        if let Some(profile) = profiles.iter_mut().find(|p| p.id == id) {
            if profile.remember_secret {
                self.secrets.delete(profile)?;
            }
            profile.remember_secret = false;
        }
        self.save("profiles.json", &profiles)
    }

    pub fn profiles(&self) -> Result<Vec<Profile>> {
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        self.load("profiles.json")
    }

    pub fn save_profile(&self, profile: Profile) -> Result<()> {
        profile.validate()?;
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        let mut profiles: Vec<Profile> = self.load("profiles.json")?;
        profiles.retain(|p| p.id != profile.id);
        profiles.push(profile);
        self.save("profiles.json", &profiles)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        let mut profiles: Vec<Profile> = self.load("profiles.json")?;
        if let Some(profile) = profiles.iter().find(|p| p.id == id && p.remember_secret) {
            self.secrets.delete(profile)?;
        }
        profiles.retain(|p| p.id != id);
        self.save("profiles.json", &profiles)
    }

    pub(crate) fn check_host(&self, host: &str, port: u16, fingerprint: &str) -> Result<HostTrust> {
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        let hosts: BTreeMap<String, String> = self.load("known_hosts.json")?;
        Ok(match hosts.get(&host_key(host, port)) {
            None => HostTrust::Unknown,
            Some(known) if known == fingerprint => HostTrust::Trusted,
            Some(known) => HostTrust::Changed(known.clone()),
        })
    }

    pub(crate) fn trust_host(&self, host: &str, port: u16, fingerprint: &str) -> Result<()> {
        let _lock = self.operations.lock().unwrap_or_else(|e| e.into_inner());
        let mut hosts: BTreeMap<String, String> = self.load("known_hosts.json")?;
        let key = host_key(host, port);
        if let Some(known) = hosts.get(&key)
            && known != fingerprint
        {
            bail!("主机指纹已被其他连接更新，请重新连接并核对");
        }
        hosts.insert(key, fingerprint.into());
        self.save("known_hosts.json", &hosts)
    }

    fn load<T: DeserializeOwned + Default>(&self, name: &str) -> Result<T> {
        let path = self.root.join(name);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("配置文件格式错误：{}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(error) => Err(error).with_context(|| format!("无法读取配置：{}", path.display())),
        }
    }

    fn save(&self, name: &str, value: &impl Serialize) -> Result<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        serde_json::to_writer_pretty(&mut temporary, value)?;
        temporary.flush()?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(self.root.join(name))
            .map_err(|e| e.error)?;
        Ok(())
    }
}

fn host_key(host: &str, port: u16) -> String {
    format!(
        "[{}]:{port}",
        host.trim().trim_matches(['[', ']']).to_ascii_lowercase()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_identity_is_persisted_and_changes_are_blocked() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = Store::open(dir.path())?;
        assert_eq!(
            store.check_host("EXAMPLE", 22, "SHA256:a")?,
            HostTrust::Unknown
        );
        store.trust_host("example", 22, "SHA256:a")?;
        let store = Store::open(dir.path())?;
        assert_eq!(
            store.check_host("EXAMPLE", 22, "SHA256:a")?,
            HostTrust::Trusted
        );
        assert!(matches!(
            store.check_host("example", 22, "SHA256:b")?,
            HostTrust::Changed(_)
        ));
        assert!(store.trust_host("example", 22, "SHA256:b").is_err());
        assert_eq!(
            store.check_host("example", 2222, "SHA256:a")?,
            HostTrust::Unknown
        );
        Ok(())
    }

    #[test]
    fn editing_profile_replaces_it_without_saving_secrets() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = Store::open(dir.path())?;
        let mut profile = Profile {
            host: "localhost".into(),
            ..Profile::default()
        };
        store.save_profile(profile.clone())?;
        profile.name = "updated".into();
        store.save_profile(profile)?;
        let profiles = store.profiles()?;
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "updated");
        assert!(!fs::read_to_string(dir.path().join("profiles.json"))?.contains("password\":"));
        Ok(())
    }

    #[test]
    fn settings_roundtrip_and_invalid_edits_leave_previous_file_intact() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = Store::open(dir.path())?;
        let mut settings = store.settings()?;
        settings.theme = crate::ThemeMode::Light;
        settings.terminal.font_size = 20;
        settings.terminal.palette_preset = crate::PalettePreset::Dracula;
        settings.terminal.highlighting.logs = false;
        settings.terminal.highlighting.language = crate::CodeLanguage::CSharp;
        settings.background.opacity = 35;
        assert!(!settings.sftp_panel.visible);
        settings.sftp_panel = crate::SftpPanelSettings {
            visible: true,
            left: true,
            width: 480,
        };
        store.save_settings(&settings)?;
        assert_eq!(Store::open(dir.path())?.settings()?, settings);
        settings.sftp_panel.visible = false;
        store.save_settings(&settings)?;
        assert_eq!(Store::open(dir.path())?.settings()?, settings);
        let previous = fs::read(dir.path().join("settings.json"))?;
        settings.sftp_panel.width = 0;
        assert!(store.save_settings(&settings).is_err());
        assert_eq!(fs::read(dir.path().join("settings.json"))?, previous);
        settings.sftp_panel.width = 480;
        settings.keymap.paste = settings.keymap.copy.clone();
        assert!(store.save_settings(&settings).is_err());
        assert_eq!(fs::read(dir.path().join("settings.json"))?, previous);
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn failed_profile_commit_restores_the_previous_credential() -> Result<()> {
        use std::{os::windows::fs::OpenOptionsExt, sync::Arc};
        let dir = tempfile::tempdir()?;
        let mut store = Store::open(dir.path())?;
        store
            .secrets
            .set_backend(Arc::new(crate::secrets::MemorySecrets::default()));
        let profile = Profile {
            host: "synthetic.invalid".into(),
            remember_secret: true,
            ..Default::default()
        };
        store.save_connection(
            profile.clone(),
            &Credentials::password("previous-test-secret".into()),
        )?;
        // Allow reads but deny atomic replacement, as can happen when a scanner locks the file.
        let _locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(dir.path().join("profiles.json"))?;
        assert!(
            store
                .save_connection(
                    profile.clone(),
                    &Credentials::password("replacement-test-secret".into())
                )
                .is_err()
        );
        assert_eq!(
            &*store
                .resolve_credentials(&profile, Credentials::default())?
                .password,
            "previous-test-secret"
        );
        Ok(())
    }

    #[test]
    fn credentials_are_scoped_reused_replaced_and_forgotten_without_plaintext_json() -> Result<()> {
        use crate::secrets::MemorySecrets;
        use std::sync::Arc;
        let dir = tempfile::tempdir()?;
        let mut store = Store::open(dir.path())?;
        let backend = Arc::new(MemorySecrets::default());
        store.secrets.set_backend(backend.clone());
        let mut profile = Profile {
            host: "example.test".into(),
            remember_secret: true,
            ..Default::default()
        };
        store.save_connection(
            profile.clone(),
            &Credentials::password("synthetic-only-secret".into()),
        )?;
        assert_eq!(
            &*store
                .resolve_credentials(&profile, Credentials::default())?
                .password,
            "synthetic-only-secret"
        );
        store.save_connection(profile.clone(), &Credentials::default())?;
        assert!(
            !fs::read_to_string(dir.path().join("profiles.json"))?
                .contains("synthetic-only-secret")
        );
        let mut changed = profile.clone();
        changed.host = "another.test".into();
        assert!(
            store
                .resolve_credentials(&changed, Credentials::default())
                .is_err()
        );
        changed = profile.clone();
        changed.username = "another-user".into();
        assert!(
            store
                .resolve_credentials(&changed, Credentials::default())
                .is_err()
        );
        let other = Store::open(tempfile::tempdir()?.path())?;
        assert_ne!(
            store.secrets.identity(&profile),
            other.secrets.identity(&profile)
        );
        store.save_connection(
            profile.clone(),
            &Credentials::password("replacement".into()),
        )?;
        assert_eq!(
            &*store
                .resolve_credentials(&profile, Credentials::default())?
                .password,
            "replacement"
        );
        profile.auth = AuthMethod::PrivateKey;
        profile.private_key_path = Some("synthetic-key".into());
        store.save_connection(
            profile.clone(),
            &Credentials::passphrase("key-phrase".into()),
        )?;
        assert_eq!(backend.0.lock().unwrap().len(), 1);
        assert_eq!(
            &*store
                .resolve_credentials(&profile, Credentials::default())?
                .passphrase,
            "key-phrase"
        );
        store.forget_secret(&profile.id)?;
        assert!(backend.0.lock().unwrap().is_empty());
        assert!(!store.profiles()?[0].remember_secret);
        store.save_connection(
            profile.clone(),
            &Credentials::passphrase("key-phrase".into()),
        )?;
        store.delete_profile(&profile.id)?;
        assert!(backend.0.lock().unwrap().is_empty());
        assert!(store.profiles()?.is_empty());
        Ok(())
    }
}
