use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::services::network_proxy_service::{load_proxy_password, resolve_proxy};
use crate::services::secret_store::SecretStore;
use crate::services::settings_store::SettingsStore;
use crate::services::update_service::UpdateService;

const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(60);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const UPDATE_DOWNLOAD_ATTEMPTS: u8 = 3;
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
    attempt: u8,
    max_attempts: u8,
}

fn is_retryable_download_error(error: &tauri_plugin_updater::Error) -> bool {
    match error {
        tauri_plugin_updater::Error::Reqwest(error) => {
            error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
        }
        tauri_plugin_updater::Error::Network(message) => ["408", "429", "500", "502", "503", "504"]
            .iter()
            .any(|status| message.contains(status)),
        _ => false,
    }
}

fn format_download_error(error: &tauri_plugin_updater::Error) -> String {
    match error {
        tauri_plugin_updater::Error::Reqwest(source) if source.is_timeout() => {
            "更新包下载超时，请检查网络或代理后重试".to_string()
        }
        tauri_plugin_updater::Error::Reqwest(_) => {
            "更新包下载连接失败，请检查网络或代理后重试".to_string()
        }
        tauri_plugin_updater::Error::Network(message) => {
            format!("更新服务器拒绝了下载请求：{message}")
        }
        tauri_plugin_updater::Error::Minisign(_)
        | tauri_plugin_updater::Error::Base64(_)
        | tauri_plugin_updater::Error::SignatureUtf8(_) => {
            format!("更新包签名校验失败，为安全起见已停止安装：{error}")
        }
        _ => format!("更新包下载失败：{error}"),
    }
}

fn format_install_error(error: &tauri_plugin_updater::Error) -> String {
    match error {
        tauri_plugin_updater::Error::AuthenticationFailed => {
            "系统未授权安装更新，请确认权限后重试".to_string()
        }
        tauri_plugin_updater::Error::PackageInstallFailed
        | tauri_plugin_updater::Error::DebInstallFailed => {
            format!("更新包已下载，但系统安装失败：{error}")
        }
        _ => format!("更新包已下载，但安装失败：{error}"),
    }
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
    // The updater stores this timeout on the returned Update as well. Keep a generous
    // download timeout, and bound the much smaller manifest request separately below.
    let mut builder = app_handle
        .updater_builder()
        .timeout(UPDATE_DOWNLOAD_TIMEOUT);
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
    let update = tokio::time::timeout(UPDATE_CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| {
            format!(
                "检查更新超时（{} 秒），请检查网络或代理后重试",
                UPDATE_CHECK_TIMEOUT.as_secs()
            )
        })?
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
            attempt: 1,
            max_attempts: UPDATE_DOWNLOAD_ATTEMPTS,
        },
    );

    let mut attempt = 1;
    let bytes = loop {
        let progress_handle = app_handle.clone();
        match update
            .download(
                move |chunk_length, content_length| {
                    let _ = progress_handle.emit(
                        UPDATE_PROGRESS_EVENT,
                        AppUpdateProgress {
                            kind: "progress",
                            chunk_length,
                            content_length,
                            attempt,
                            max_attempts: UPDATE_DOWNLOAD_ATTEMPTS,
                        },
                    );
                },
                || {},
            )
            .await
        {
            Ok(bytes) => break bytes,
            Err(error)
                if attempt < UPDATE_DOWNLOAD_ATTEMPTS && is_retryable_download_error(&error) =>
            {
                tokio::time::sleep(Duration::from_secs(u64::from(attempt))).await;
                attempt += 1;
                let _ = app_handle.emit(
                    UPDATE_PROGRESS_EVENT,
                    AppUpdateProgress {
                        kind: "started",
                        chunk_length: 0,
                        content_length: None,
                        attempt,
                        max_attempts: UPDATE_DOWNLOAD_ATTEMPTS,
                    },
                );
            }
            Err(error) => return Err(format_download_error(&error)),
        }
    };

    let _ = app_handle.emit(
        UPDATE_PROGRESS_EVENT,
        AppUpdateProgress {
            kind: "finished",
            chunk_length: 0,
            content_length: Some(bytes.len() as u64),
            attempt,
            max_attempts: UPDATE_DOWNLOAD_ATTEMPTS,
        },
    );
    update
        .install(&bytes)
        .map_err(|error| format_install_error(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_transient_http_statuses() {
        assert!(is_retryable_download_error(
            &tauri_plugin_updater::Error::Network(
                "Download request failed with status: 503 Service Unavailable".to_string(),
            )
        ));
        assert!(!is_retryable_download_error(
            &tauri_plugin_updater::Error::Network(
                "Download request failed with status: 404 Not Found".to_string(),
            )
        ));
    }

    #[test]
    fn signature_failures_explain_that_installation_was_stopped() {
        let error = tauri_plugin_updater::Error::SignatureUtf8("invalid".to_string());
        assert!(format_download_error(&error).contains("为安全起见已停止安装"));
    }
}
