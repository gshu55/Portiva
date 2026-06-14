use tauri::{AppHandle, State};

use crate::domain::connection::ConnectionTransportKind;
use crate::domain::terminal::{
    TerminalSession, TerminalSessionStatus, TerminalSize, TerminalSnapshot,
};
use crate::services::connection_manager::ConnectionManager;
use crate::services::local_shell_service::LocalShellService;
use crate::services::serial_service::SerialService;
use crate::services::ssh_session_service::SshSessionService;
use crate::services::tcp_terminal_service::TcpTerminalService;
use crate::services::terminal_service::TerminalService;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellOpenResult {
    pub connection: crate::domain::connection::ConnectionSession,
    pub terminal: TerminalSession,
    pub terminal_snapshot: TerminalSnapshot,
}

#[tauri::command]
pub fn local_shell_open(
    size: TerminalSize,
    app_handle: AppHandle,
    connection_manager: State<'_, ConnectionManager>,
    local_shells: State<'_, LocalShellService>,
    terminal_service: State<'_, TerminalService>,
) -> Result<LocalShellOpenResult, String> {
    let connection = connection_manager.open_local_shell("本地终端".to_string())?;
    let terminal = match terminal_service.attach(connection.id.clone(), size.clone()) {
        Ok(terminal) => terminal,
        Err(error) => {
            let _ = connection_manager.close(&connection.id);
            return Err(error);
        }
    };

    let shell_info = match local_shells.open(&connection.id, &terminal.id, &size, app_handle) {
        Ok(shell_info) => shell_info,
        Err(error) => {
            let _ = terminal_service.close(&terminal.id);
            let _ = connection_manager.close(&connection.id);
            return Err(error);
        }
    };
    let connection = connection_manager.update_title(
        &connection.id,
        format!("本地终端 / {}", shell_info.shell_label),
    )?;
    let terminal_snapshot = terminal_service.snapshot(&terminal.id)?;

    Ok(LocalShellOpenResult {
        connection,
        terminal,
        terminal_snapshot,
    })
}

#[tauri::command]
pub async fn terminal_attach(
    connection_id: String,
    size: TerminalSize,
    app_handle: AppHandle,
    connection_manager: State<'_, ConnectionManager>,
    local_shells: State<'_, LocalShellService>,
    terminal_service: State<'_, TerminalService>,
    ssh_sessions: State<'_, SshSessionService>,
    serial_service: State<'_, SerialService>,
    tcp_terminals: State<'_, TcpTerminalService>,
) -> Result<TerminalSession, String> {
    let session = connection_manager
        .get(&connection_id)?
        .ok_or_else(|| format!("connection not found: {connection_id}"))?;

    if !session.capabilities.terminal {
        return Err("connection does not support terminal sessions".to_string());
    }

    let transport_kind = session.transport.as_ref().map(|transport| &transport.kind);
    let is_ssh_transport = matches!(transport_kind, Some(ConnectionTransportKind::Ssh));
    let is_local_shell_transport =
        matches!(transport_kind, Some(ConnectionTransportKind::LocalShell));
    let is_serial_transport = matches!(transport_kind, Some(ConnectionTransportKind::Serial));
    let is_tcp_transport = matches!(
        transport_kind,
        Some(ConnectionTransportKind::Telnet | ConnectionTransportKind::RawTcp)
    );

    if is_ssh_transport && !session.is_authenticated() {
        return Err(
            "SSH transport is verified, but user authentication is still pending".to_string(),
        );
    }

    let terminal = terminal_service.attach(connection_id.clone(), size.clone())?;
    if is_ssh_transport {
        if let Err(error) = ssh_sessions
            .open_pty(&connection_id, &terminal.id, &size, app_handle)
            .await
        {
            let _ = terminal_service.close(&terminal.id);
            return Err(error);
        }
        let _ = connection_manager.mark_terminal_channel_ready(&connection_id)?;
    } else if is_local_shell_transport {
        if let Err(error) = local_shells.open(&connection_id, &terminal.id, &size, app_handle) {
            let _ = terminal_service.close(&terminal.id);
            return Err(error);
        }
    } else if is_serial_transport {
        if let Err(error) = serial_service.open_terminal(&connection_id, &terminal.id, app_handle) {
            let _ = terminal_service.close(&terminal.id);
            return Err(error);
        }
    } else if is_tcp_transport {
        if let Err(error) =
            tcp_terminals.open_terminal(&connection_id, &terminal.id, &size, app_handle)
        {
            let _ = terminal_service.close(&terminal.id);
            return Err(error);
        }
    }

    Ok(terminal)
}

#[tauri::command]
pub fn terminal_session(
    terminal_id: String,
    terminal_service: State<'_, TerminalService>,
) -> Result<TerminalSession, String> {
    terminal_service.session(&terminal_id)
}

#[tauri::command]
pub async fn terminal_write(
    terminal_id: String,
    data: String,
    local_shells: State<'_, LocalShellService>,
    terminal_service: State<'_, TerminalService>,
    ssh_sessions: State<'_, SshSessionService>,
    serial_service: State<'_, SerialService>,
    tcp_terminals: State<'_, TcpTerminalService>,
) -> Result<(), String> {
    let terminal = terminal_service.session(&terminal_id)?;
    if matches!(terminal.status, TerminalSessionStatus::Closed) {
        return Err("终端已断开，请重连标签页后继续".to_string());
    }

    if ssh_sessions.has_pty(&terminal.connection_id, &terminal_id)? {
        if let Err(error) = ssh_sessions
            .write_pty(&terminal.connection_id, &terminal_id, &data)
            .await
        {
            let _ = terminal_service
                .append_disconnect_notice(&terminal_id, &format!("SSH 写入失败：{error}"));
            return Err(error);
        }
        return Ok(());
    }

    if local_shells.has_pty(&terminal.connection_id, &terminal_id)? {
        return local_shells.write_pty(&terminal.connection_id, &terminal_id, &data);
    }

    if serial_service.has_terminal(&terminal.connection_id, &terminal_id)? {
        if let Err(error) =
            serial_service.write_terminal(&terminal.connection_id, &terminal_id, &data)
        {
            if serial_write_error_closes_terminal(&error) {
                let _ = terminal_service
                    .append_disconnect_notice(&terminal_id, &format!("串口写入失败：{error}"));
            }
            return Err(error);
        }
        return Ok(());
    }

    if tcp_terminals.has_terminal(&terminal.connection_id, &terminal_id)? {
        if let Err(error) =
            tcp_terminals.write_terminal(&terminal.connection_id, &terminal_id, &data)
        {
            let _ = terminal_service
                .append_disconnect_notice(&terminal_id, &format!("TCP 写入失败：{error}"));
            return Err(error);
        }
        return Ok(());
    }

    terminal_service.write(&terminal_id, &data)
}

#[tauri::command]
pub async fn terminal_write_bytes(
    terminal_id: String,
    bytes: Vec<u8>,
    terminal_service: State<'_, TerminalService>,
    serial_service: State<'_, SerialService>,
    tcp_terminals: State<'_, TcpTerminalService>,
) -> Result<(), String> {
    let terminal = terminal_service.session(&terminal_id)?;
    if matches!(terminal.status, TerminalSessionStatus::Closed) {
        return Err("终端已断开，请重连标签页后继续".to_string());
    }

    if serial_service.has_terminal(&terminal.connection_id, &terminal_id)? {
        if let Err(error) =
            serial_service.write_terminal_bytes(&terminal.connection_id, &terminal_id, &bytes)
        {
            let _ = terminal_service
                .append_disconnect_notice(&terminal_id, &format!("串口写入失败：{error}"));
            return Err(error);
        }
        return Ok(());
    }

    if tcp_terminals.has_terminal(&terminal.connection_id, &terminal_id)? {
        if let Err(error) =
            tcp_terminals.write_terminal_bytes(&terminal.connection_id, &terminal_id, &bytes)
        {
            let _ = terminal_service
                .append_disconnect_notice(&terminal_id, &format!("Raw TCP 写入失败：{error}"));
            return Err(error);
        }
        return Ok(());
    }

    Err("原始字节写入仅支持串口和 Raw TCP 终端。".to_string())
}

fn serial_write_error_closes_terminal(error: &str) -> bool {
    !error.contains("cannot be encoded")
}

#[tauri::command]
pub async fn terminal_resize(
    terminal_id: String,
    size: TerminalSize,
    local_shells: State<'_, LocalShellService>,
    terminal_service: State<'_, TerminalService>,
    ssh_sessions: State<'_, SshSessionService>,
    tcp_terminals: State<'_, TcpTerminalService>,
) -> Result<(), String> {
    let terminal = terminal_service.session(&terminal_id)?;
    if ssh_sessions.has_pty(&terminal.connection_id, &terminal_id)? {
        ssh_sessions
            .resize_pty(&terminal.connection_id, &terminal_id, &size)
            .await?;
    }

    if local_shells.has_pty(&terminal.connection_id, &terminal_id)? {
        local_shells.resize_pty(&terminal.connection_id, &terminal_id, &size)?;
    }

    if tcp_terminals.has_terminal(&terminal.connection_id, &terminal_id)? {
        tcp_terminals.resize_terminal(&terminal.connection_id, &terminal_id, &size)?;
    }

    terminal_service.resize(&terminal_id, size)
}

#[tauri::command]
pub async fn terminal_close(
    terminal_id: String,
    local_shells: State<'_, LocalShellService>,
    terminal_service: State<'_, TerminalService>,
    ssh_sessions: State<'_, SshSessionService>,
    serial_service: State<'_, SerialService>,
    tcp_terminals: State<'_, TcpTerminalService>,
) -> Result<(), String> {
    if let Ok(terminal) = terminal_service.session(&terminal_id) {
        if ssh_sessions.has_pty(&terminal.connection_id, &terminal_id)? {
            let _ = ssh_sessions
                .close_pty(&terminal.connection_id, &terminal_id)
                .await?;
        }

        if local_shells.has_pty(&terminal.connection_id, &terminal_id)? {
            let _ = local_shells.close_pty(&terminal.connection_id, &terminal_id)?;
        }

        if serial_service.has_terminal(&terminal.connection_id, &terminal_id)? {
            let _ = serial_service.close_terminal(&terminal.connection_id, &terminal_id)?;
        }

        if tcp_terminals.has_terminal(&terminal.connection_id, &terminal_id)? {
            let _ = tcp_terminals.close_terminal(&terminal.connection_id, &terminal_id)?;
        }
    }

    terminal_service.close(&terminal_id)
}

#[tauri::command]
pub async fn terminal_snapshot(
    terminal_id: String,
    terminal_service: State<'_, TerminalService>,
    ssh_sessions: State<'_, SshSessionService>,
) -> Result<TerminalSnapshot, String> {
    let terminal = terminal_service.session(&terminal_id)?;
    if ssh_sessions.has_pty(&terminal.connection_id, &terminal_id)? {
        let output = ssh_sessions
            .drain_pty_output(&terminal.connection_id, &terminal_id)
            .await?;
        terminal_service.append_output(&terminal_id, &output)?;
    }

    terminal_service.snapshot(&terminal_id)
}
