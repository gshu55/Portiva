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
pub async fn secret_set(
    profile_id: String,
    purpose: SecretPurpose,
    value: String,
    secrets: State<'_, SecretStore>,
) -> Result<SecretMetadata, String> {
    let secrets = secrets.inner().clone();
    run_secret_task(secrets, move |store| {
        store.set_secret(profile_id, purpose, value)
    })
    .await
}

#[tauri::command]
pub async fn secret_delete(
    secret_id: String,
    secrets: State<'_, SecretStore>,
) -> Result<(), String> {
    let secrets = secrets.inner().clone();
    run_secret_task(secrets, move |store| store.delete(&secret_id)).await
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

async fn run_secret_task<T, F>(secrets: SecretStore, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(SecretStore) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || task(secrets))
        .await
        .map_err(|error| format!("系统凭据库任务执行失败：{error}"))?
}
