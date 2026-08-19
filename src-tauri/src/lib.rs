mod commands;
mod domain;
mod protocol;
mod security;
mod services;
mod utils;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

const DETACHED_TAB_WINDOW_PREFIX: &str = "portiva-tab-";
const DETACHED_TERMINAL_WINDOW_PREFIX: &str = "portiva-terminal-";
const TRAY_SHOW_MENU_ID: &str = "portiva-tray-show";
const TRAY_LOCAL_TERMINAL_MENU_ID: &str = "portiva-tray-local-terminal";
const TRAY_SERIAL_TERMINAL_MENU_ID: &str = "portiva-tray-serial-terminal";
const TRAY_HTTP_MENU_ID: &str = "portiva-tray-http";
const TRAY_NETWORK_SCAN_MENU_ID: &str = "portiva-tray-network-scan";
const TRAY_QUIT_MENU_ID: &str = "portiva-tray-quit";
const TRAY_QUICK_ACTION_EVENT: &str = "portiva://tray-quick-action";

fn is_portiva_window(label: &str) -> bool {
    label == "main"
        || label.starts_with(DETACHED_TAB_WINDOW_PREFIX)
        || label.starts_with(DETACHED_TERMINAL_WINDOW_PREFIX)
}

fn hide_portiva_windows<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) {
    for (label, window) in manager.webview_windows() {
        if is_portiva_window(&label) {
            let _ = window.hide();
        }
    }
}

fn show_portiva_windows<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) {
    for (label, window) in manager.webview_windows() {
        if is_portiva_window(&label) {
            let _ = window.show();
        }
    }

    if let Some(main_window) = manager.get_webview_window("main") {
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
    }
}

fn dispatch_tray_quick_action<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>, action: &str) {
    if let Some(main_window) = app_handle.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
    }

    let _ = app_handle.emit_to("main", TRAY_QUICK_ACTION_EVENT, action);
}

fn destroy_detached_terminal_windows<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) {
    for (label, window) in manager.webview_windows() {
        if label.starts_with(DETACHED_TAB_WINDOW_PREFIX)
            || label.starts_with(DETACHED_TERMINAL_WINDOW_PREFIX)
        {
            let _ = window.destroy();
        }
    }
}

fn setup_system_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW_MENU_ID, "显示 Portiva", true, None::<&str>)?;
    let quick_action_separator = PredefinedMenuItem::separator(app)?;
    let local_terminal_item = MenuItem::with_id(
        app,
        TRAY_LOCAL_TERMINAL_MENU_ID,
        "打开本地终端",
        true,
        None::<&str>,
    )?;
    let serial_terminal_item = MenuItem::with_id(
        app,
        TRAY_SERIAL_TERMINAL_MENU_ID,
        "打开串口终端",
        true,
        None::<&str>,
    )?;
    let http_item = MenuItem::with_id(app, TRAY_HTTP_MENU_ID, "打开 HTTP", true, None::<&str>)?;
    let network_scan_item = MenuItem::with_id(
        app,
        TRAY_NETWORK_SCAN_MENU_ID,
        "打开局域网扫描",
        true,
        None::<&str>,
    )?;
    let quit_separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_MENU_ID, "退出 Portiva", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &quick_action_separator,
            &local_terminal_item,
            &serial_terminal_item,
            &http_item,
            &network_scan_item,
            &quit_separator,
            &quit_item,
        ],
    )?;
    let mut tray_builder = TrayIconBuilder::new()
        .tooltip("Portiva")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            TRAY_SHOW_MENU_ID => show_portiva_windows(app_handle),
            TRAY_LOCAL_TERMINAL_MENU_ID => dispatch_tray_quick_action(app_handle, "local-terminal"),
            TRAY_SERIAL_TERMINAL_MENU_ID => {
                dispatch_tray_quick_action(app_handle, "serial-terminal")
            }
            TRAY_HTTP_MENU_ID => dispatch_tray_quick_action(app_handle, "http"),
            TRAY_NETWORK_SCAN_MENU_ID => dispatch_tray_quick_action(app_handle, "network-scan"),
            TRAY_QUIT_MENU_ID => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_portiva_windows(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let tray_available = Arc::new(AtomicBool::new(false));
    let tray_available_for_setup = Arc::clone(&tray_available);
    let tray_available_for_window = Arc::clone(&tray_available);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .manage(services::network_scan_service::NetworkScanService::default())
        .manage(services::update_service::UpdateService::default())
        .manage(services::protocol_registry::ProtocolRegistry)
        .manage(services::tunnel_service::TunnelService::default())
        .manage(services::serial_service::SerialService::default())
        .setup(move |app| {
            match setup_system_tray(app) {
                Ok(()) => tray_available_for_setup.store(true, Ordering::Release),
                Err(error) => eprintln!("failed to create Portiva system tray: {error}"),
            }
            Ok(())
        })
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
            commands::security::secret_reveal_password,
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
            commands::connection::ssh_collect_host_overview,
            commands::connection::connection_get,
            commands::connection::connection_get_capabilities,
            commands::clipboard::clipboard_read_text,
            commands::clipboard::clipboard_write_html,
            commands::clipboard::clipboard_write_text,
            commands::terminal::local_shell_open,
            commands::terminal::wsl_distributions_list,
            commands::terminal::wsl_collect_host_overview,
            commands::terminal::wsl_shell_open,
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
            commands::file_transfer::file_transfer_upload_batch,
            commands::file_transfer::file_transfer_download,
            commands::file_transfer::file_transfer_mkdir,
            commands::file_transfer::file_transfer_remove,
            commands::file_transfer::file_transfer_rename,
            commands::file_transfer::file_transfer_cancel,
            commands::file_transfer::file_transfer_pause,
            commands::file_transfer::file_transfer_resume,
            commands::file_transfer::file_transfer_resolve_conflict,
            commands::file_transfer::file_transfer_retry,
            commands::file_transfer::file_transfer_delete,
            commands::file_transfer::local_download_directory,
            commands::file_transfer::local_file_list,
            commands::file_transfer::local_file_mkdir,
            commands::file_transfer::local_file_remove,
            commands::file_transfer::local_file_rename,
            commands::file_transfer::local_reveal_item_in_directory,
            commands::file_transfer::transfer_list,
            commands::wsl_files::wsl_file_home,
            commands::wsl_files::wsl_file_list,
            commands::wsl_files::wsl_file_mkdir,
            commands::wsl_files::wsl_file_remove,
            commands::wsl_files::wsl_file_rename,
            commands::wsl_files::wsl_transfer_upload,
            commands::wsl_files::wsl_transfer_download,
            commands::wsl_files::wsl_transfer_list,
            commands::wsl_files::wsl_transfer_action,
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
            commands::fonts::system_fonts_list,
            commands::logs::log_clear,
            commands::logs::log_list,
            commands::logs::log_record_placeholder,
            commands::network_scan::network_scan_interfaces,
            commands::network_scan::network_scan_start,
            commands::network_scan::network_scan_cancel,
            commands::network_proxy::network_proxy_password_status,
            commands::network_proxy::network_proxy_password_set,
            commands::network_proxy::network_proxy_password_delete,
            commands::updater::app_update_check,
            commands::updater::app_update_download_and_install,
        ])
        .on_window_event(move |window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if tray_available_for_window.load(Ordering::Acquire) {
                        api.prevent_close();
                        hide_portiva_windows(window.app_handle());
                    } else {
                        destroy_detached_terminal_windows(window.app_handle());
                    }
                }
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
