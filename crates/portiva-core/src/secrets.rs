//! OS credential storage, isolated by data directory and the connection's authentication identity.
use crate::Profile;
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use zeroize::Zeroizing;

pub(crate) trait SecretBackend: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>>;
    fn set(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}
struct OsKeyring;
impl OsKeyring {
    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new("Portiva2", account).context("无法打开系统凭据库")
    }
}
impl SecretBackend for OsKeyring {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("无法读取系统凭据；请解锁系统凭据库或重新输入"),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<()> {
        Self::entry(account)?
            .set_password(value)
            .context("无法保存到系统凭据库")
    }
    fn delete(&self, account: &str) -> Result<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("无法删除系统凭据"),
        }
    }
}

pub(crate) struct SecretStore {
    namespace: Vec<u8>,
    backend: Arc<dyn SecretBackend>,
}
impl SecretStore {
    pub fn new(root: &Path) -> Result<Self> {
        Ok(Self {
            namespace: dunce::canonicalize(root)?
                .as_os_str()
                .as_encoded_bytes()
                .to_vec(),
            backend: Arc::new(OsKeyring),
        })
    }
    pub fn identity(&self, profile: &Profile) -> String {
        // Length-delimited encoding avoids separator collisions, and hides host/user/path metadata
        // in credential account names. A changed destination never receives the old password.
        let bytes = serde_json::to_vec(&(
            &self.namespace,
            &profile.id,
            profile.host.trim().to_ascii_lowercase(),
            profile.port,
            &profile.username,
            &profile.auth,
            if profile.auth == crate::AuthMethod::PrivateKey {
                profile
                    .private_key_path
                    .as_ref()
                    .map(|p| p.as_os_str().as_encoded_bytes())
            } else {
                None
            },
        ))
        .expect("connection identity is serializable");
        format!("ssh-{:x}", Sha256::digest(bytes))
    }
    pub fn get(&self, profile: &Profile) -> Result<Option<Zeroizing<String>>> {
        self.backend.get(&self.identity(profile))
    }
    pub fn set(&self, profile: &Profile, value: &str) -> Result<()> {
        self.backend.set(&self.identity(profile), value)
    }
    pub fn delete(&self, profile: &Profile) -> Result<()> {
        self.backend.delete(&self.identity(profile))
    }
    #[cfg(test)]
    pub fn set_backend(&mut self, backend: Arc<dyn SecretBackend>) {
        self.backend = backend;
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemorySecrets(pub std::sync::Mutex<std::collections::HashMap<String, String>>);
#[cfg(test)]
impl SecretBackend for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(Zeroizing::new))
    }
    fn set(&self, account: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}
