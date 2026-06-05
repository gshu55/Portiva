use std::collections::HashMap;
use std::ffi::c_void;
use std::fs;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Mutex;

use crate::domain::secret::{SecretMetadata, SecretPurpose};
use crate::utils::{app_paths, clock};

pub struct SecretStore {
    secrets: Mutex<HashMap<String, StoredSecret>>,
    path: Option<PathBuf>,
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
        Self {
            secrets: Mutex::new(HashMap::new()),
            path: None,
        }
    }

    pub fn with_path(path: PathBuf) -> Self {
        Self {
            secrets: Mutex::new(load_secret_metadata(&path).unwrap_or_default()),
            path: Some(path),
        }
    }

    pub fn create_placeholder(
        &self,
        profile_id: String,
        purpose: SecretPurpose,
    ) -> Result<SecretMetadata, String> {
        // TODO: write encrypted secret value with Stronghold or OS keyring. This stores metadata only.
        let id = format!("secret:{}:{}", profile_id, purpose_label(&purpose));
        let metadata = SecretMetadata {
            id: id.clone(),
            profile_id,
            purpose,
            created_at: clock::now_stamp(),
            has_value: false,
        };
        let stored = StoredSecret {
            metadata,
            protected_value: None,
            protection: None,
        };

        self.secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .insert(id, stored.clone());

        self.persist()?;

        Ok(stored.metadata)
    }

    pub fn set_secret(
        &self,
        profile_id: String,
        purpose: SecretPurpose,
        value: String,
    ) -> Result<SecretMetadata, String> {
        if value.is_empty() {
            return Err("secret value cannot be empty".to_string());
        }

        let protected = protect_secret(value.as_bytes())?;
        let id = format!("secret:{}:{}", profile_id, purpose_label(&purpose));
        let stored = StoredSecret {
            metadata: SecretMetadata {
                id: id.clone(),
                profile_id,
                purpose,
                created_at: clock::now_stamp(),
                has_value: true,
            },
            protected_value: Some(hex_encode(&protected)),
            protection: Some(protection_label().to_string()),
        };

        self.secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .insert(id, stored.clone());

        self.persist()?;

        Ok(stored.metadata)
    }

    pub fn get_secret(
        &self,
        profile_id: &str,
        purpose: SecretPurpose,
    ) -> Result<Option<String>, String> {
        let id = format!("secret:{}:{}", profile_id, purpose_label(&purpose));
        let stored = self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .get(&id)
            .cloned();
        let Some(stored) = stored else {
            return Ok(None);
        };
        let Some(protected_value) = stored.protected_value else {
            return Ok(None);
        };
        let raw = hex_decode(&protected_value)?;
        let secret = unprotect_secret(&raw)?;

        String::from_utf8(secret)
            .map(Some)
            .map_err(|error| format!("stored secret is not valid UTF-8: {error}"))
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
        self.secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .remove(secret_id);

        self.persist()?;

        Ok(())
    }

    pub fn contains(&self, secret_id: &str) -> Result<bool, String> {
        Ok(self
            .secrets
            .lock()
            .map_err(|_| "secret store lock poisoned".to_string())?
            .contains_key(secret_id))
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
    if !path.exists() {
        return Err("secrets metadata file does not exist".to_string());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read secrets metadata: {error}"))?;
    let secrets: Vec<StoredSecret> = serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse secrets metadata: {error}"))?;

    let mut stored = HashMap::new();
    for mut secret in secrets {
        secret.metadata.has_value = secret.protected_value.is_some();
        validate_metadata(&secret.metadata)?;
        stored.insert(secret.metadata.id.clone(), secret);
    }

    Ok(stored)
}

fn write_secret_metadata(path: &Path, secrets: &[StoredSecret]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create secrets metadata directory: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(secrets)
        .map_err(|error| format!("failed to encode secrets metadata: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("failed to write secrets metadata: {error}"))
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
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);

    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }

    output
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
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

fn protection_label() -> &'static str {
    #[cfg(windows)]
    {
        "windows-dpapi-current-user"
    }

    #[cfg(not(windows))]
    {
        "unsupported"
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
    fn CryptProtectData(
        p_data_in: *mut DataBlob,
        sz_data_descr: *const u16,
        p_optional_entropy: *mut DataBlob,
        pv_reserved: *mut c_void,
        p_prompt_struct: *mut c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;

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
fn protect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
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
        CryptProtectData(
            &mut input,
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 {
        return Err("Windows DPAPI failed to protect secret".to_string());
    }

    let protected = unsafe {
        let bytes = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
        let _ = LocalFree(output.pb_data.cast::<c_void>());
        bytes
    };

    Ok(protected)
}

#[cfg(windows)]
fn unprotect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
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
fn protect_secret(_value: &[u8]) -> Result<Vec<u8>, String> {
    Err("encrypted local password storage is only enabled on Windows in this build".to_string())
}

#[cfg(not(windows))]
fn unprotect_secret(_value: &[u8]) -> Result<Vec<u8>, String> {
    Err("encrypted local password storage is only enabled on Windows in this build".to_string())
}

#[cfg(test)]
mod tests {
    use super::SecretStore;
    use crate::domain::secret::SecretPurpose;
    use std::path::PathBuf;

    #[test]
    fn stores_metadata_without_secret_value() {
        let store = SecretStore::in_memory();
        let metadata = store
            .create_placeholder("profile-1".to_string(), SecretPurpose::Password)
            .unwrap();

        assert_eq!(metadata.id, "secret:profile-1:password");
        assert!(metadata.created_at.starts_with("unix:"));
        assert!(store.contains(&metadata.id).unwrap());
    }

    #[test]
    fn deletes_secret_metadata() {
        let store = SecretStore::in_memory();
        let metadata = store
            .create_placeholder("profile-1".to_string(), SecretPurpose::Token)
            .unwrap();

        store.delete(&metadata.id).unwrap();

        assert!(!store.contains(&metadata.id).unwrap());
    }

    #[test]
    fn persists_secret_metadata_without_secret_value() {
        let path = test_path("secrets-persist.json");
        let _ = std::fs::remove_file(&path);

        let store = SecretStore::with_path(path.clone());
        let metadata = store
            .create_placeholder("profile-1".to_string(), SecretPurpose::Password)
            .unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains(&metadata.id));
        assert!(!raw.contains("hunter2"));

        let reloaded = SecretStore::with_path(path.clone());
        assert!(reloaded.contains(&metadata.id).unwrap());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delete_updates_persisted_secret_metadata() {
        let path = test_path("secrets-delete.json");
        let _ = std::fs::remove_file(&path);

        let store = SecretStore::with_path(path.clone());
        let metadata = store
            .create_placeholder("profile-1".to_string(), SecretPurpose::Token)
            .unwrap();
        store.delete(&metadata.id).unwrap();

        let reloaded = SecretStore::with_path(path.clone());
        assert!(!reloaded.contains(&metadata.id).unwrap());

        let _ = std::fs::remove_file(path);
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
