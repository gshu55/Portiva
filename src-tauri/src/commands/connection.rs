use tauri::State;

use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::ConnectionSession;
use crate::domain::logging::LogLevel;
use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::services::connection_manager::ConnectionManager;
use crate::services::file_transfer_service::FileTransferService;
use crate::services::known_hosts_store::KnownHostsStore;
use crate::services::local_shell_service::LocalShellService;
use crate::services::log_service::LogService;
use crate::services::serial_service::SerialService;
use crate::services::ssh_session_service::SshSessionService;
use crate::services::terminal_service::TerminalService;
use crate::services::transfer_service::TransferService;

#[tauri::command]
pub async fn connection_open(
    profile: ConnectionProfile,
    manager: State<'_, ConnectionManager>,
    known_hosts: State<'_, KnownHostsStore>,
    ssh_sessions: State<'_, SshSessionService>,
    serial_service: State<'_, SerialService>,
    logs: State<'_, LogService>,
) -> Result<ConnectionSession, String> {
    let session = if matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp) {
        let session = manager.open_pending_ssh_transport(profile.clone())?;
        let transport = match ssh_sessions
            .connect_trusted(&session.id, &profile, &known_hosts)
            .await
        {
            Ok(transport) => transport,
            Err(error) => {
                let _ = manager.close(&session.id);
                return Err(error);
            }
        };
        let session = if let Ok(session) = manager.mark_ssh_transport_ready(
            &session.id,
            transport.host,
            transport.port,
            transport.host_key_fingerprint,
        ) {
            session
        } else {
            let _ = ssh_sessions.close(&session.id).await;
            let _ = manager.close(&session.id);
            return Err("failed to mark SSH transport ready".to_string());
        };
        if let Ok(Some(description)) = ssh_sessions.describe(&session.id) {
            let _ = logs.record(
                LogLevel::Info,
                "connection",
                format!("ssh session active {description}"),
            );
        }
        session
    } else {
        let session = manager.open_placeholder(profile.clone())?;
        if matches!(profile.r#type, ConnectionType::Serial) {
            if let Err(error) = serial_service.register_profile(&session.id, profile) {
                let _ = manager.close(&session.id);
                return Err(error);
            }
        }
        session
    };
    let _ = logs.record(
        LogLevel::Info,
        "connection",
        format_connection_opened(&session),
    );
    Ok(session)
}

#[tauri::command]
pub async fn connection_close(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
    terminal_service: State<'_, TerminalService>,
    local_shells: State<'_, LocalShellService>,
    file_transfer_service: State<'_, FileTransferService>,
    transfer_service: State<'_, TransferService>,
    ssh_sessions: State<'_, SshSessionService>,
    serial_service: State<'_, SerialService>,
    logs: State<'_, LogService>,
) -> Result<(), String> {
    let closed_terminals = terminal_service.close_by_connection(&connection_id)?;
    let closed_local_ptys = local_shells.close_ptys_by_connection(&connection_id)?;
    let closed_ssh_ptys = ssh_sessions
        .close_ptys_by_connection(&connection_id)
        .await?;
    let closed_file_sessions = file_transfer_service.close_by_connection(&connection_id)?;
    let cancelled_transfers = transfer_service.cancel_by_connection(&connection_id)?;
    let closed_ssh_session = ssh_sessions.close(&connection_id).await?;
    let closed_serial_terminals = serial_service.close_by_connection(&connection_id)?;
    manager.close(&connection_id)?;
    let _ = logs.record(
        LogLevel::Info,
        "connection",
        format!(
            "closed {connection_id}; released {closed_terminals} terminals, {closed_local_ptys} local ptys, {closed_ssh_ptys} ssh ptys, {closed_serial_terminals} serial terminals, {closed_file_sessions} file sessions, cancelled {cancelled_transfers} transfers, closed ssh session: {closed_ssh_session}"
        ),
    );
    Ok(())
}

#[tauri::command]
pub async fn ssh_authenticate_password(
    connection_id: String,
    password: String,
    manager: State<'_, ConnectionManager>,
    ssh_sessions: State<'_, SshSessionService>,
    logs: State<'_, LogService>,
) -> Result<ConnectionSession, String> {
    let outcome = ssh_sessions
        .authenticate_password(&connection_id, password)
        .await?;
    let session = manager.mark_ssh_authenticated(&connection_id, false)?;
    let _ = logs.record(
        LogLevel::Info,
        "connection",
        format!(
            "ssh password auth completed for {connection_id}; sftp requested: {}",
            outcome.enable_sftp
        ),
    );

    Ok(session)
}

#[tauri::command]
pub async fn ssh_authenticate_private_key(
    connection_id: String,
    private_key_path: String,
    passphrase: Option<String>,
    manager: State<'_, ConnectionManager>,
    ssh_sessions: State<'_, SshSessionService>,
    logs: State<'_, LogService>,
) -> Result<ConnectionSession, String> {
    let outcome = ssh_sessions
        .authenticate_private_key(&connection_id, private_key_path, passphrase)
        .await?;
    let session = manager.mark_ssh_authenticated(&connection_id, false)?;
    let _ = logs.record(
        LogLevel::Info,
        "connection",
        format!(
            "ssh private key auth completed for {connection_id}; sftp requested: {}",
            outcome.enable_sftp
        ),
    );

    Ok(session)
}

#[tauri::command]
pub fn ssh_authenticate_agent(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
    ssh_sessions: State<'_, SshSessionService>,
    logs: State<'_, LogService>,
) -> Result<ConnectionSession, String> {
    let outcome = tauri::async_runtime::block_on(ssh_sessions.authenticate_agent(&connection_id))?;
    let session = manager.mark_ssh_authenticated(&connection_id, false)?;
    let _ = logs.record(
        LogLevel::Info,
        "connection",
        format!(
            "ssh agent auth completed for {connection_id}; sftp requested: {}",
            outcome.enable_sftp
        ),
    );

    Ok(session)
}

fn format_connection_opened(session: &ConnectionSession) -> String {
    let Some(transport) = &session.transport else {
        return format!("opened {}", session.title);
    };

    match &transport.server_identification {
        Some(server_identification) => format!(
            "opened {} transport {}:{} ({server_identification})",
            session.title, transport.host, transport.port
        ),
        None => format!(
            "opened {} transport {}:{}",
            session.title, transport.host, transport.port
        ),
    }
}

#[tauri::command]
pub fn connection_get(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<ConnectionSession, String> {
    manager
        .get(&connection_id)?
        .ok_or_else(|| format!("connection not found: {connection_id}"))
}

#[tauri::command]
pub fn connection_get_capabilities(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<ConnectionCapabilities, String> {
    manager
        .get(&connection_id)?
        .map(|session| session.capabilities)
        .ok_or_else(|| format!("connection not found: {connection_id}"))
}
