use tauri::State;

use crate::domain::secret::SecretPurpose;
use crate::services::network_proxy_service::PROXY_SECRET_PROFILE_ID;
use crate::services::secret_store::SecretStore;

#[tauri::command]
pub fn network_proxy_password_status(secrets: State<'_, SecretStore>) -> Result<bool, String> {
    Ok(secrets.list()?.iter().any(|secret| {
        secret.profile_id == PROXY_SECRET_PROFILE_ID
            && secret.purpose == SecretPurpose::ProxyPassword
            && secret.has_value
    }))
}

#[tauri::command]
pub async fn network_proxy_password_set(
    password: String,
    secrets: State<'_, SecretStore>,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("代理密码不能为空".to_string());
    }
    let secrets = secrets.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        secrets
            .set_secret(
                PROXY_SECRET_PROFILE_ID.to_string(),
                SecretPurpose::ProxyPassword,
                password,
            )
            .map(|_| ())
    })
    .await
    .map_err(|error| format!("保存代理密码任务失败：{error}"))?
}

#[tauri::command]
pub async fn network_proxy_password_delete(secrets: State<'_, SecretStore>) -> Result<(), String> {
    let secrets = secrets.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        secrets.delete_for_profile_purpose(PROXY_SECRET_PROFILE_ID, SecretPurpose::ProxyPassword)
    })
    .await
    .map_err(|error| format!("删除代理密码任务失败：{error}"))?
}
