use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};

#[cfg(windows)]
use std::{ffi::c_void, ptr};

use crate::domain::secret::{SecretMetadata, SecretPurpose};
use crate::utils::{app_paths, clock, json_store};

const KEYRING_SERVICE: &str = "Portiva";
const KEYRING_MASTER_KEY_ACCOUNT: &str = "credential-master-key-v2";
const LEGACY_OS_KEYRING_PROTECTION: &str = "os-keyring-v1";
const MASTER_KEY_PROTECTION: &str = "keyring-master-key-aes256gcm-v2";
const CREDENTIAL_MASTER_KEY_BYTES: usize = 32;
const CREDENTIAL_NONCE_BYTES: usize = 12;
const LEGACY_WINDOWS_DPAPI_PROTECTION: &str = "windows-dpapi-current-user";

trait CredentialBackend: Send + Sync {
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct OsCredentialBackend;

impl OsCredentialBackend {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|error| credential_error("创建凭据项", error))
    }
}

impl CredentialBackend for OsCredentialBackend {
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|error| credential_error("保存凭据", error))
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(credential_error("读取凭据", error)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(credential_error("删除凭据", error)),
        }
    }
}

fn credential_error(action: &str, error: keyring::Error) -> String {
    match error {
        keyring::Error::NoStorageAccess(detail) if action == "读取凭据" => format!(
            "系统凭据库读取凭据失败：当前应用没有访问权限，或系统凭据库已锁定（{detail}）。请重新输入并保存"
        ),
        keyring::Error::PlatformFailure(detail) if action == "读取凭据" => format!(
            "系统凭据库读取凭据失败：系统拒绝了当前应用的读取请求（{detail}）。请重新输入并保存"
        ),
        error => format!("系统凭据库{action}失败：{error}"),
    }
}

#[cfg(test)]
#[derive(Default)]
struct MemoryCredentialBackend {
    values: Mutex<HashMap<String, String>>,
    get_calls: Mutex<HashMap<String, usize>>,
}

#[cfg(test)]
impl MemoryCredentialBackend {
    fn get_count(&self, account: &str) -> usize {
        self.get_calls
            .lock()
            .expect("test credential get counter lock poisoned")
            .get(account)
            .copied()
            .unwrap_or_default()
    }
}

#[cfg(test)]
impl CredentialBackend for MemoryCredentialBackend {
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "test credential store lock poisoned".to_string())?
            .insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let mut calls = self
            .get_calls
            .lock()
            .map_err(|_| "test credential get counter lock poisoned".to_string())?;
        *calls.entry(account.to_string()).or_default() += 1;
        drop(calls);
        Ok(self
            .values
            .lock()
            .map_err(|_| "test credential store lock poisoned".to_string())?
            .get(account)
            .cloned())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "test credential store lock poisoned".to_string())?
            .remove(account);
        Ok(())
    }
}

#[derive(Clone)]
pub struct SecretStore {
    secrets: Arc<Mutex<HashMap<String, StoredSecret>>>,
    credential_master_key: Arc<Mutex<Option<[u8; CREDENTIAL_MASTER_KEY_BYTES]>>>,
    path: Option<PathBuf>,
    backend: Arc<dyn CredentialBackend>,
    credential_operations: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSecret {
    #[serde(flatten)]
    metadata: SecretMetadata,
    protected_value: Option<String>,
    protection: Option<String>,
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::with_path(app_paths::secrets_metadata_path())
    }
}

impl SecretStore {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::with_backend(None, Arc::new(MemoryCredentialBackend::default()))
    }

    pub fn with_path(path: PathBuf) -> Self {
        Self::with_backend(Some(path), Arc::new(OsCredentialBackend))
    }

    fn with_backend(path: Option<PathBuf>, backend: Arc<dyn CredentialBackend>) -> Self {
        let secrets = path
            .as_deref()
            .map(load_secret_metadata)
            .transpose()
            .unwrap_or_else(|error| {
                eprintln!("failed to load secret metadata; using an empty index: {error}");
                Some(HashMap::new())
            })
            .unwrap_or_default();

        Self {
            secrets: Arc::new(Mutex::new(secrets)),
            credential_master_key: Arc::new(Mutex::new(None)),
            path,
            backend,
            credential_operations: Arc::new(Mutex::new(())),
        }
    }

    pub fn set_secret(
        &self,
        profile_id: String,
        purpose: SecretPurpose,
        value: String,
    ) -> Result<SecretMetadata, String> {
        let _operation = self.lock_credential_operation()?;
        if value.is_empty() {
            return Err("secret value cannot be empty".to_string());
        }

        let id = secret_id(&profile_id, &purpose);
        let protected_value = self.encrypt_secret(&id, value.as_bytes())?;
        let stored = StoredSecret {
            metadata: SecretMetadata {
                id: id.clone(),
                profile_id,
                purpose,
                created_at: clock::now_stamp(),
                has_value: true,
            },
            protected_value: Some(protected_value),
            protection: Some(MASTER_KEY_PROTECTION.to_string()),
        };

        let previous = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .insert(id.clone(), stored.clone());
        let previous_was_legacy_keyring = previous.as_ref().is_some_and(|stored| {
            stored.protection.as_deref() == Some(LEGACY_OS_KEYRING_PROTECTION)
        });

        if let Err(error) = self.persist() {
            self.restore_stored(&id, previous)?;
            return Err(error);
        }
        if previous_was_legacy_keyring {
            if let Err(error) = self.backend.delete(&id) {
                eprintln!("failed to remove replaced legacy credential {id}: {error}");
            }
        }

        Ok(stored.metadata)
    }

    pub fn get_secret(
        &self,
        profile_id: &str,
        purpose: SecretPurpose,
    ) -> Result<Option<String>, String> {
        let _operation = self.lock_credential_operation()?;
        let id = secret_id(profile_id, &purpose);
        let stored = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .get(&id)
            .cloned();
        let Some(stored) = stored else {
            return Ok(None);
        };
        match stored.protection.as_deref() {
            Some(MASTER_KEY_PROTECTION) => {
                let protected_value = stored
                    .protected_value
                    .as_deref()
                    .ok_or_else(|| "凭据密文数据不完整".to_string())?;
                Ok(Some(self.decrypt_secret(&id, protected_value)?))
            }
            Some(LEGACY_OS_KEYRING_PROTECTION) => {
                let value = self.backend.get(&id)?;
                if let Some(value) = value {
                    self.migrate_legacy_keyring_value(&id, value.clone(), &stored)?;
                    Ok(Some(value))
                } else {
                    self.mark_credential_missing(&id)?;
                    Ok(None)
                }
            }
            Some(LEGACY_WINDOWS_DPAPI_PROTECTION) => {
                let protected_value = stored
                    .protected_value
                    .as_deref()
                    .ok_or_else(|| "旧版 Windows 密码数据不完整".to_string())?;
                let raw = hex_decode(protected_value)?;
                let secret = unprotect_legacy_windows_secret(&raw)?;
                let value = String::from_utf8(secret)
                    .map_err(|error| format!("旧版密码不是有效的 UTF-8：{error}"))?;

                let protected_value = self.encrypt_secret(&id, value.as_bytes())?;
                self.replace_with_master_key_metadata(&id, protected_value, &stored)?;
                Ok(Some(value))
            }
            Some(protection) => Err(format!("不支持的密码保护格式：{protection}")),
            None if stored.protected_value.is_some() => {
                Err("密码数据缺少保护格式标识，无法安全读取".to_string())
            }
            None => Ok(None),
        }
    }

    pub fn list(&self) -> Result<Vec<SecretMetadata>, String> {
        let mut secrets = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .values()
            .map(|stored| stored.metadata.clone())
            .collect::<Vec<_>>();
        secrets.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(secrets)
    }

    pub fn delete(&self, secret_id: &str) -> Result<(), String> {
        let _operation = self.lock_credential_operation()?;
        self.delete_locked(secret_id)
    }

    fn delete_locked(&self, secret_id: &str) -> Result<(), String> {
        let stored = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .get(secret_id)
            .cloned();

        let Some(stored) = stored else {
            return Ok(());
        };

        let previous_credential =
            if stored.protection.as_deref() == Some(LEGACY_OS_KEYRING_PROTECTION) {
                self.backend.get(secret_id)?
            } else {
                None
            };

        if stored.protection.as_deref() == Some(LEGACY_OS_KEYRING_PROTECTION) {
            self.backend.delete(secret_id)?;
        }

        self.secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .remove(secret_id);

        if let Err(error) = self.persist() {
            self.secrets
                .lock()
                .map_err(|_| "secret store lock poisoned".to_string())?
                .insert(secret_id.to_string(), stored.clone());
            let credential_rollback = if let Some(previous_credential) = previous_credential {
                self.backend.set(secret_id, &previous_credential)
            } else {
                Ok(())
            };
            return Err(match credential_rollback {
                Ok(()) => error,
                Err(rollback_error) => {
                    format!("{error}; credential rollback unavailable: {rollback_error}")
                }
            });
        }

        Ok(())
    }

    pub fn delete_for_profile(&self, profile_id: &str) -> Result<(), String> {
        let _operation = self.lock_credential_operation()?;
        let secret_ids = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .values()
            .filter(|stored| stored.metadata.profile_id == profile_id)
            .map(|stored| stored.metadata.id.clone())
            .collect::<Vec<_>>();

        for secret_id in secret_ids {
            self.delete_locked(&secret_id)?;
        }

        Ok(())
    }

    pub fn delete_for_profile_purpose(
        &self,
        profile_id: &str,
        purpose: SecretPurpose,
    ) -> Result<(), String> {
        let _operation = self.lock_credential_operation()?;
        self.delete_locked(&secret_id(profile_id, &purpose))
    }

    fn lock_credential_operation(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.credential_operations
            .lock()
            .map_err(|_| "credential operation lock poisoned".to_string())
    }

    fn load_master_key(
        &self,
        create_if_missing: bool,
    ) -> Result<[u8; CREDENTIAL_MASTER_KEY_BYTES], String> {
        if let Some(key) = self
            .credential_master_key
            .lock()
            .map_err(|_| "credential master key cache lock poisoned".to_string())?
            .as_ref()
            .copied()
        {
            return Ok(key);
        }

        let key = match self.backend.get(KEYRING_MASTER_KEY_ACCOUNT)? {
            Some(encoded) => {
                let bytes = BASE64_STANDARD
                    .decode(encoded)
                    .map_err(|error| format!("Portiva 凭据主密钥编码损坏：{error}"))?;
                bytes.try_into().map_err(|bytes: Vec<u8>| {
                    format!("Portiva 凭据主密钥长度无效：{} 字节", bytes.len())
                })?
            }
            None if create_if_missing => {
                let mut key = [0_u8; CREDENTIAL_MASTER_KEY_BYTES];
                SystemRandom::new()
                    .fill(&mut key)
                    .map_err(|_| "生成 Portiva 凭据主密钥失败".to_string())?;
                self.backend
                    .set(KEYRING_MASTER_KEY_ACCOUNT, &BASE64_STANDARD.encode(key))?;
                key
            }
            None => return Err("未找到 Portiva 凭据主密钥，请重新输入并保存相关密码".to_string()),
        };

        *self
            .credential_master_key
            .lock()
            .map_err(|_| "credential master key cache lock poisoned".to_string())? = Some(key);
        Ok(key)
    }

    fn encrypt_secret(&self, secret_id: &str, value: &[u8]) -> Result<String, String> {
        let key = self.load_master_key(true)?;
        let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
            .map_err(|_| "初始化 Portiva 凭据加密失败".to_string())?;
        let key = aead::LessSafeKey::new(unbound);
        let mut nonce = [0_u8; CREDENTIAL_NONCE_BYTES];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "生成 Portiva 凭据随机数失败".to_string())?;
        let mut encrypted = value.to_vec();
        key.seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(secret_id.as_bytes()),
            &mut encrypted,
        )
        .map_err(|_| "加密 Portiva 凭据失败".to_string())?;

        let mut payload = Vec::with_capacity(CREDENTIAL_NONCE_BYTES + encrypted.len());
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&encrypted);
        Ok(BASE64_STANDARD.encode(payload))
    }

    fn decrypt_secret(&self, secret_id: &str, protected_value: &str) -> Result<String, String> {
        let payload = BASE64_STANDARD
            .decode(protected_value)
            .map_err(|error| format!("Portiva 凭据密文编码损坏：{error}"))?;
        if payload.len() < CREDENTIAL_NONCE_BYTES + aead::AES_256_GCM.tag_len() {
            return Err("Portiva 凭据密文长度无效".to_string());
        }

        let nonce: [u8; CREDENTIAL_NONCE_BYTES] = payload[..CREDENTIAL_NONCE_BYTES]
            .try_into()
            .map_err(|_| "Portiva 凭据随机数长度无效".to_string())?;
        let mut encrypted = payload[CREDENTIAL_NONCE_BYTES..].to_vec();
        let master_key = self.load_master_key(false)?;
        let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &master_key)
            .map_err(|_| "初始化 Portiva 凭据解密失败".to_string())?;
        let key = aead::LessSafeKey::new(unbound);
        let plain = key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(secret_id.as_bytes()),
                &mut encrypted,
            )
            .map_err(|_| "Portiva 凭据解密或完整性校验失败".to_string())?;
        String::from_utf8(plain.to_vec())
            .map_err(|error| format!("Portiva 凭据不是有效的 UTF-8：{error}"))
    }

    fn migrate_legacy_keyring_value(
        &self,
        secret_id: &str,
        value: String,
        previous: &StoredSecret,
    ) -> Result<(), String> {
        let protected_value = self.encrypt_secret(secret_id, value.as_bytes())?;
        self.replace_with_master_key_metadata(secret_id, protected_value, previous)?;
        if let Err(error) = self.backend.delete(secret_id) {
            eprintln!("failed to remove migrated legacy credential {secret_id}: {error}");
        }
        Ok(())
    }

    fn replace_with_master_key_metadata(
        &self,
        secret_id: &str,
        protected_value: String,
        previous: &StoredSecret,
    ) -> Result<(), String> {
        let mut stored = previous.clone();
        stored.metadata.has_value = true;
        stored.protected_value = Some(protected_value);
        stored.protection = Some(MASTER_KEY_PROTECTION.to_string());

        self.secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .insert(secret_id.to_string(), stored);

        if let Err(error) = self.persist() {
            self.secrets
                .lock()
                .map_err(|_| "secret store lock poisoned".to_string())?
                .insert(secret_id.to_string(), previous.clone());
            return Err(error);
        }

        Ok(())
    }

    fn mark_credential_missing(&self, secret_id: &str) -> Result<(), String> {
        let mut secrets = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?;
        let Some(stored) = secrets.get_mut(secret_id) else {
            return Ok(());
        };
        let previous = stored.clone();
        stored.metadata.has_value = false;
        stored.protected_value = None;
        stored.protection = None;
        drop(secrets);

        if let Err(error) = self.persist() {
            self.secrets
                .lock()
                .map_err(|_| "secret store lock poisoned".to_string())?
                .insert(secret_id.to_string(), previous);
            return Err(error);
        }
        Ok(())
    }

    fn restore_stored(
        &self,
        secret_id: &str,
        previous: Option<StoredSecret>,
    ) -> Result<(), String> {
        let mut secrets = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?;
        if let Some(previous) = previous {
            secrets.insert(secret_id.to_string(), previous);
        } else {
            secrets.remove(secret_id);
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };

        let mut secrets = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        secrets.sort_by(|left, right| left.metadata.id.cmp(&right.metadata.id));
        write_secret_metadata(path, &secrets)
    }
}

fn load_secret_metadata(path: &Path) -> Result<HashMap<String, StoredSecret>, String> {
    let secrets: Vec<StoredSecret> =
        json_store::load_json(path, "secrets metadata")?.unwrap_or_default();

    let mut stored = HashMap::new();
    for mut secret in secrets {
        secret.metadata.has_value = secret.protected_value.is_some()
            || secret.protection.as_deref() == Some(LEGACY_OS_KEYRING_PROTECTION);
        validate_metadata(&secret.metadata)?;
        stored.insert(secret.metadata.id.clone(), secret);
    }

    Ok(stored)
}

fn write_secret_metadata(path: &Path, secrets: &[StoredSecret]) -> Result<(), String> {
    json_store::write_json(path, secrets, "secrets metadata")
}

fn validate_metadata(metadata: &SecretMetadata) -> Result<(), String> {
    if metadata.id.trim().is_empty() {
        return Err("secret metadata id is required".to_string());
    }

    if metadata.profile_id.trim().is_empty() {
        return Err("secret metadata profile id is required".to_string());
    }

    Ok(())
}

fn purpose_label(purpose: &SecretPurpose) -> &'static str {
    match purpose {
        SecretPurpose::Password => "password",
        SecretPurpose::PrivateKeyPassphrase => "private-key-passphrase",
        SecretPurpose::Token => "token",
        SecretPurpose::ProxyPassword => "proxy-password",
    }
}

fn secret_id(profile_id: &str, purpose: &SecretPurpose) -> String {
    format!("secret:{profile_id}:{}", purpose_label(purpose))
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("protected secret encoding is invalid".to_string());
    }

    let mut output = Vec::with_capacity(value.len() / 2);
    for chunk in value.as_bytes().chunks_exact(2) {
        let high = hex_nibble(chunk[0])?;
        let low = hex_nibble(chunk[1])?;
        output.push((high << 4) | low);
    }

    Ok(output)
}

fn hex_nibble(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("protected secret encoding contains invalid hex".to_string()),
    }
}

#[cfg(windows)]
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(windows)]
#[link(name = "Crypt32")]
extern "system" {
    fn CryptUnprotectData(
        p_data_in: *mut DataBlob,
        ppsz_data_descr: *mut *mut u16,
        p_optional_entropy: *mut DataBlob,
        pv_reserved: *mut c_void,
        p_prompt_struct: *mut c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;
}

#[cfg(windows)]
#[link(name = "Kernel32")]
extern "system" {
    fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
}

#[cfg(windows)]
fn unprotect_legacy_windows_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    let mut input = DataBlob {
        cb_data: value.len() as u32,
        pb_data: value.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 {
        return Err("Windows DPAPI failed to unprotect secret".to_string());
    }

    let secret = unsafe {
        let bytes = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
        let _ = LocalFree(output.pb_data.cast::<c_void>());
        bytes
    };

    Ok(secret)
}

#[cfg(not(windows))]
fn unprotect_legacy_windows_secret(_value: &[u8]) -> Result<Vec<u8>, String> {
    Err("旧版 Windows 密码只能在原 Windows 用户账户下迁移，请重新输入并保存".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        credential_error, secret_id, write_secret_metadata, CredentialBackend,
        MemoryCredentialBackend, SecretStore, StoredSecret, KEYRING_MASTER_KEY_ACCOUNT,
        LEGACY_OS_KEYRING_PROTECTION, MASTER_KEY_PROTECTION,
    };
    use crate::domain::secret::{SecretMetadata, SecretPurpose};
    use std::path::PathBuf;
    use std::sync::Arc;

    #[test]
    fn credential_access_failure_explains_how_to_recover() {
        let error = credential_error(
            "读取凭据",
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "permission denied",
            ))),
        );

        assert!(error.contains("当前应用没有访问权限"));
        assert!(error.contains("请重新输入并保存"));
    }

    #[test]
    fn deletes_secret_metadata() {
        let store = SecretStore::in_memory();
        let metadata = store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Token,
                "token".to_string(),
            )
            .unwrap();

        store.delete(&metadata.id).unwrap();

        assert!(store.list().unwrap().is_empty());
        assert!(store
            .get_secret("profile-1", SecretPurpose::Token)
            .unwrap()
            .is_none());
    }

    #[test]
    fn delete_updates_persisted_secret_metadata() {
        let path = test_path("secrets-delete.json");
        let _ = std::fs::remove_file(&path);

        let backend = Arc::new(MemoryCredentialBackend::default());
        let store = SecretStore::with_backend(Some(path.clone()), backend.clone());
        let metadata = store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Token,
                "token".to_string(),
            )
            .unwrap();
        store.delete(&metadata.id).unwrap();

        let reloaded = SecretStore::with_backend(Some(path.clone()), backend);
        assert!(reloaded.list().unwrap().is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn encrypts_secret_metadata_with_a_keyring_backed_master_key() {
        let path = test_path("secrets-keyring.json");
        let _ = std::fs::remove_file(&path);
        let backend = Arc::new(MemoryCredentialBackend::default());
        let store = SecretStore::with_backend(Some(path.clone()), backend.clone());

        let metadata = store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Password,
                "hunter2".to_string(),
            )
            .unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains(MASTER_KEY_PROTECTION));
        assert!(!raw.contains("hunter2"));
        assert!(backend
            .values
            .lock()
            .unwrap()
            .contains_key(KEYRING_MASTER_KEY_ACCOUNT));
        assert_eq!(
            store
                .get_secret("profile-1", SecretPurpose::Password)
                .unwrap()
                .as_deref(),
            Some("hunter2")
        );

        let reloaded = SecretStore::with_backend(Some(path.clone()), backend);
        assert!(reloaded.list().unwrap()[0].has_value);
        assert_eq!(
            reloaded
                .get_secret("profile-1", SecretPurpose::Password)
                .unwrap()
                .as_deref(),
            Some("hunter2")
        );
        reloaded.delete(&metadata.id).unwrap();
        assert!(reloaded.list().unwrap().is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn one_master_key_read_unlocks_multiple_profile_credentials_for_the_app_session() {
        let path = test_path("secrets-session-cache.json");
        let _ = std::fs::remove_file(&path);
        let backend = Arc::new(MemoryCredentialBackend::default());
        let store = SecretStore::with_backend(Some(path.clone()), backend.clone());
        let first = store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Password,
                "one".to_string(),
            )
            .unwrap();
        let second = store
            .set_secret(
                "profile-2".to_string(),
                SecretPurpose::Password,
                "two".to_string(),
            )
            .unwrap();
        drop(store);

        let reads_before_reload = backend.get_count(KEYRING_MASTER_KEY_ACCOUNT);
        let reloaded = SecretStore::with_backend(Some(path.clone()), backend.clone());
        assert_eq!(
            reloaded
                .get_secret("profile-1", SecretPurpose::Password)
                .unwrap()
                .as_deref(),
            Some("one")
        );
        assert_eq!(
            reloaded
                .get_secret("profile-2", SecretPurpose::Password)
                .unwrap()
                .as_deref(),
            Some("two")
        );
        assert_eq!(
            backend.get_count(KEYRING_MASTER_KEY_ACCOUNT),
            reads_before_reload + 1
        );

        reloaded.delete(&first.id).unwrap();
        reloaded.delete(&second.id).unwrap();
        assert_eq!(
            backend.get_count(KEYRING_MASTER_KEY_ACCOUNT),
            reads_before_reload + 1
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn encrypted_credentials_use_unique_nonces_and_are_bound_to_their_ids() {
        let store = SecretStore::in_memory();
        let first = store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Password,
                "same-password".to_string(),
            )
            .unwrap();
        let second = store
            .set_secret(
                "profile-2".to_string(),
                SecretPurpose::Password,
                "same-password".to_string(),
            )
            .unwrap();
        let secrets = store.secrets.lock().unwrap();
        let first_ciphertext = secrets
            .get(&first.id)
            .unwrap()
            .protected_value
            .as_deref()
            .unwrap();
        let second_ciphertext = secrets
            .get(&second.id)
            .unwrap()
            .protected_value
            .as_deref()
            .unwrap();

        assert_ne!(first_ciphertext, second_ciphertext);
        assert!(store
            .decrypt_secret(&first.id, second_ciphertext)
            .unwrap_err()
            .contains("完整性校验失败"));
    }

    #[test]
    fn migrates_legacy_profile_item_to_master_key_encryption() {
        let path = test_path("secrets-master-key-migration.json");
        let _ = std::fs::remove_file(&path);
        let backend = Arc::new(MemoryCredentialBackend::default());
        let profile_id = "legacy-profile";
        let id = secret_id(profile_id, &SecretPurpose::Password);
        let legacy = StoredSecret {
            metadata: SecretMetadata {
                id: id.clone(),
                profile_id: profile_id.to_string(),
                purpose: SecretPurpose::Password,
                created_at: "legacy".to_string(),
                has_value: true,
            },
            protected_value: None,
            protection: Some(LEGACY_OS_KEYRING_PROTECTION.to_string()),
        };
        write_secret_metadata(&path, &[legacy]).unwrap();
        backend.set(&id, "legacy-password").unwrap();

        let store = SecretStore::with_backend(Some(path.clone()), backend.clone());
        assert_eq!(
            store
                .get_secret(profile_id, SecretPurpose::Password)
                .unwrap()
                .as_deref(),
            Some("legacy-password")
        );
        assert_eq!(backend.get_count(&id), 1);
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains(MASTER_KEY_PROTECTION));
        assert!(backend
            .values
            .lock()
            .unwrap()
            .contains_key(KEYRING_MASTER_KEY_ACCOUNT));
        assert!(!backend.values.lock().unwrap().contains_key(&id));
        drop(store);

        let legacy_reads = backend.get_count(&id);
        let reloaded = SecretStore::with_backend(Some(path.clone()), backend.clone());
        assert_eq!(
            reloaded
                .get_secret(profile_id, SecretPurpose::Password)
                .unwrap()
                .as_deref(),
            Some("legacy-password")
        );
        assert_eq!(backend.get_count(&id), legacy_reads);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn deleting_profile_removes_only_its_credentials() {
        let store = SecretStore::in_memory();
        store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Password,
                "one".to_string(),
            )
            .unwrap();
        store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Token,
                "token".to_string(),
            )
            .unwrap();
        store
            .set_secret(
                "profile-2".to_string(),
                SecretPurpose::Password,
                "two".to_string(),
            )
            .unwrap();

        store.delete_for_profile("profile-1").unwrap();

        assert!(store
            .get_secret("profile-1", SecretPurpose::Password)
            .unwrap()
            .is_none());
        assert!(store
            .get_secret("profile-1", SecretPurpose::Token)
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .get_secret("profile-2", SecretPurpose::Password)
                .unwrap()
                .as_deref(),
            Some("two")
        );
    }

    #[test]
    fn deleting_one_purpose_keeps_other_profile_credentials() {
        let store = SecretStore::in_memory();
        store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Password,
                "password".to_string(),
            )
            .unwrap();
        store
            .set_secret(
                "profile-1".to_string(),
                SecretPurpose::Token,
                "token".to_string(),
            )
            .unwrap();

        store
            .delete_for_profile_purpose("profile-1", SecretPurpose::Password)
            .unwrap();

        assert!(store
            .get_secret("profile-1", SecretPurpose::Password)
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .get_secret("profile-1", SecretPurpose::Token)
                .unwrap()
                .as_deref(),
            Some("token")
        );
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
