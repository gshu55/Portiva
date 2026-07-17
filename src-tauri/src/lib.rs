mod commands;
mod domain;
mod protocol;
mod security;
mod services;
mod utils;

use tauri::Manager;

const DETACHED_TAB_WINDOW_PREFIX: &str = "portiva-tab-";
const DETACHED_TERMINAL_WINDOW_PREFIX: &str = "portiva-terminal-";

fn destroy_detached_terminal_windows<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) {
    for (label, window) in manager.webview_windows() {
        if label.starts_with(DETACHED_TAB_WINDOW_PREFIX)
            || label.starts_with(DETACHED_TERMINAL_WINDOW_PREFIX)
        {
            let _ = window.destroy();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(services::connection_manager::ConnectionManager::default())
        .manage(services::profile_store::ProfileStore::default())
        .manage(services::secret_store::SecretStore::default())
        .manage(services::known_hosts_store::KnownHostsStore::default())
        .manage(services::ssh_session_service::SshSessionService::default())
        .manage(services::local_shell_service::LocalShellService::default())
        .manage(services::terminal_service::TerminalService::default())
        .manage(services::tcp_terminal_service::TcpTerminalService::default())
        .manage(services::file_transfer_service::FileTransferService::default())
        .manage(services::transfer_service::TransferService::default())
        .manage(services::http_request_service::HttpRequestService::default())
        .manage(services::http_workspace_store::HttpWorkspaceStore::default())
        .manage(services::settings_store::SettingsStore::default())
        .manage(services::log_service::LogService::default())
        .manage(services::protocol_registry::ProtocolRegistry)
        .manage(services::tunnel_service::TunnelService::default())
        .manage(services::serial_service::SerialService::default())
        .invoke_handler(tauri::generate_handler![
            commands::profiles::profile_list,
            commands::profiles::profile_groups,
            commands::profiles::profile_recent,
            commands::profiles::profile_mark_recent,
            commands::profiles::profile_create,
            commands::profiles::profile_update,
            commands::profiles::profile_delete,
            commands::profiles::profile_test_connection,
            commands::profiles::known_host_trust_placeholder,
            commands::security::security_redact_preview,
            commands::security::secret_list,
            commands::security::secret_set,
            commands::security::secret_delete,
            commands::security::known_hosts_list,
            commands::security::known_host_delete,
            commands::protocols::protocol_list,
            commands::protocols::protocol_get,
            commands::tunnel::tunnel_create,
            commands::tunnel::tunnel_start,
            commands::tunnel::tunnel_stop,
            commands::tunnel::tunnel_list,
            commands::connection::connection_open,
            commands::connection::connection_close,
            commands::connection::ssh_authenticate_password,
            commands::connection::ssh_authenticate_saved_password,
            commands::connection::ssh_authenticate_private_key,
            commands::connection::ssh_authenticate_agent,
            commands::connection::connection_get,
            commands::connection::connection_get_capabilities,
            commands::clipboard::clipboard_read_text,
            commands::clipboard::clipboard_write_html,
            commands::clipboard::clipboard_write_text,
            commands::terminal::local_shell_open,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_session,
            commands::terminal::terminal_write,
            commands::terminal::terminal_write_bytes,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_snapshot,
            commands::file_transfer::file_transfer_open,
            commands::file_transfer::file_transfer_session,
            commands::file_transfer::file_transfer_close,
            commands::file_transfer::file_transfer_list,
            commands::file_transfer::file_transfer_upload,
            commands::file_transfer::file_transfer_download,
            commands::file_transfer::file_transfer_mkdir,
            commands::file_transfer::file_transfer_remove,
            commands::file_transfer::file_transfer_rename,
            commands::file_transfer::file_transfer_cancel,
            commands::file_transfer::file_transfer_pause,
            commands::file_transfer::file_transfer_resume,
            commands::file_transfer::file_transfer_retry,
            commands::file_transfer::file_transfer_delete,
            commands::file_transfer::local_download_directory,
            commands::file_transfer::local_file_list,
            commands::file_transfer::local_file_mkdir,
            commands::file_transfer::local_file_remove,
            commands::file_transfer::local_file_rename,
            commands::file_transfer::local_reveal_item_in_directory,
            commands::file_transfer::transfer_list,
            commands::http::http_send,
            commands::http::http_send_stream,
            commands::http::http_cancel,
            commands::http_workspace::http_workspaces_get,
            commands::http_workspace::http_workspaces_save,
            commands::serial::serial_list_ports,
            commands::serial::serial_terminal_create,
            commands::serial::serial_terminal_close,
            commands::serial::serial_terminal_open,
            commands::serial::serial_terminal_reconfigure,
            commands::settings::settings_get,
            commands::settings::settings_update,
            commands::logs::log_clear,
            commands::logs::log_list,
            commands::logs::log_record_placeholder,
        ])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                destroy_detached_terminal_windows(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            destroy_detached_terminal_windows(app_handle);
        }
    });
}
