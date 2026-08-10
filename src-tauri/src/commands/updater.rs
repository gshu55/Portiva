use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::services::network_proxy_service::{load_proxy_password, resolve_proxy};
use crate::services::secret_store::SecretStore;
use crate::services::settings_store::SettingsStore;
use crate::services::update_service::UpdateService;

const UPDATE_TIMEOUT: Duration = Duration::from_secs(60);
const UPDATE_PROGRESS_EVENT: &str = "portiva://update-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub current_version: String,
    pub version: String,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress {
    kind: &'static str,
    chunk_length: usize,
    content_length: Option<u64>,
}

#[tauri::command]
pub async fn app_update_check(
    app_handle: AppHandle,
    settings: State<'_, SettingsStore>,
    secrets: State<'_, SecretStore>,
    updates: State<'_, UpdateService>,
) -> Result<Option<AppUpdateMetadata>, String> {
    let proxy_settings = settings.get()?.network.proxy;
    let password = load_proxy_password(&proxy_settings, secrets.inner().clone()).await?;
    let resolved_proxy = resolve_proxy(&proxy_settings, "https", password.as_deref())?;
    let mut builder = app_handle.updater_builder().timeout(UPDATE_TIMEOUT);
    builder = match resolved_proxy {
        Some(proxy) => {
            let url = reqwest_updater::Url::parse(&proxy.authenticated_url()?)
                .map_err(|error| format!("代理地址无效：{error}"))?;
            builder.proxy(url)
        }
        None => builder.no_proxy(),
    };

    let updater = builder
        .build()
        .map_err(|error| format!("更新服务初始化失败：{error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;
    let mut pending = updates.pending.lock().await;
    let Some(update) = update else {
        *pending = None;
        return Ok(None);
    };
    let metadata = AppUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
    };
    *pending = Some(update);
    Ok(Some(metadata))
}

#[tauri::command]
pub async fn app_update_download_and_install(
    app_handle: AppHandle,
    updates: State<'_, UpdateService>,
) -> Result<(), String> {
    let pending = updates.pending.lock().await;
    let update = pending
        .as_ref()
        .ok_or_else(|| "没有可安装的更新，请重新检查".to_string())?;
    let _ = app_handle.emit(
        UPDATE_PROGRESS_EVENT,
        AppUpdateProgress {
            kind: "started",
            chunk_length: 0,
            content_length: None,
        },
    );
    let progress_handle = app_handle.clone();
    let finished_handle = app_handle.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = progress_handle.emit(
                    UPDATE_PROGRESS_EVENT,
                    AppUpdateProgress {
                        kind: "progress",
                        chunk_length,
                        content_length,
                    },
                );
            },
            move || {
                let _ = finished_handle.emit(
                    UPDATE_PROGRESS_EVENT,
                    AppUpdateProgress {
                        kind: "finished",
                        chunk_length: 0,
                        content_length: None,
                    },
                );
            },
        )
        .await
        .map_err(|error| format!("更新安装失败：{error}"))
}
