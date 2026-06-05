use tauri::State;

use crate::domain::secret::{KnownHostEntry, SecretMetadata, SecretPurpose};
use crate::security::fingerprint::display_fingerprint;
use crate::security::redaction;
use crate::services::known_hosts_store::KnownHostsStore;
use crate::services::secret_store::SecretStore;

#[tauri::command]
pub fn secret_list(secrets: State<'_, SecretStore>) -> Result<Vec<SecretMetadata>, String> {
    secrets.list()
}

#[tauri::command]
pub fn secret_create_placeholder(
    profile_id: String,
    purpose: SecretPurpose,
    secrets: State<'_, SecretStore>,
) -> Result<SecretMetadata, String> {
    // TODO: accept secret material via secure native prompt, not regular webview state.
    secrets.create_placeholder(profile_id, purpose)
}

#[tauri::command]
pub fn secret_set(
    profile_id: String,
    purpose: SecretPurpose,
    value: String,
    secrets: State<'_, SecretStore>,
) -> Result<SecretMetadata, String> {
    secrets.set_secret(profile_id, purpose, value)
}

#[tauri::command]
pub fn secret_get(
    profile_id: String,
    purpose: SecretPurpose,
    secrets: State<'_, SecretStore>,
) -> Result<Option<String>, String> {
    secrets.get_secret(&profile_id, purpose)
}

#[tauri::command]
pub fn secret_delete(secret_id: String, secrets: State<'_, SecretStore>) -> Result<(), String> {
    secrets.delete(&secret_id)
}

#[tauri::command]
pub fn secret_exists(secret_id: String, secrets: State<'_, SecretStore>) -> Result<bool, String> {
    secrets.contains(&secret_id)
}

#[tauri::command]
pub fn known_hosts_list(
    known_hosts: State<'_, KnownHostsStore>,
) -> Result<Vec<KnownHostEntry>, String> {
    known_hosts.list().map(|entries| {
        entries
            .into_iter()
            .map(|entry| KnownHostEntry {
                fingerprint: display_fingerprint(&entry.fingerprint),
                ..entry
            })
            .collect()
    })
}

#[tauri::command]
pub fn known_host_delete(
    host: String,
    known_hosts: State<'_, KnownHostsStore>,
) -> Result<(), String> {
    known_hosts.delete(&host)
}

#[tauri::command]
pub fn security_redact_preview(input: String) -> String {
    redaction::redact(&input)
}
