use std::time::Duration;

use tauri::State;

use crate::domain::capability::ConnectionCapabilities;
use crate::domain::connection::ConnectionSession;
use crate::domain::logging::LogLevel;
use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::domain::secret::SecretPurpose;
use crate::services::connection_manager::ConnectionManager;
use crate::services::file_transfer_service::FileTransferService;
use crate::services::known_hosts_store::KnownHostsStore;
use crate::services::local_shell_service::LocalShellService;
use crate::services::log_service::LogService;
use crate::services::profile_store::ProfileStore;
use crate::services::secret_store::SecretStore;
use crate::services::serial_service::SerialService;
use crate::services::ssh_session_service::SshSessionService;
use crate::services::tcp_terminal_service::TcpTerminalService;
use crate::services::terminal_service::TerminalService;
use crate::services::transfer_service::TransferService;

const SAVED_CREDENTIAL_READ_TIMEOUT_SECS: u64 = 30;

#[tauri::command]
pub async fn connection_open(
    profile: ConnectionProfile,
    manager: State<'_, ConnectionManager>,
    known_hosts: State<'_, KnownHostsStore>,
    ssh_sessions: State<'_, SshSessionService>,
    serial_service: State<'_, SerialService>,
    tcp_terminals: State<'_, TcpTerminalService>,
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
        } else if matches!(
            profile.r#type,
            ConnectionType::Telnet | ConnectionType::RawTcp
        ) {
            if let Err(error) = tcp_terminals.register_profile(&session.id, profile) {
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
#[allow(clippy::too_many_arguments)]
pub async fn connection_close(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
    terminal_service: State<'_, TerminalService>,
    local_shells: State<'_, LocalShellService>,
    file_transfer_service: State<'_, FileTransferService>,
    transfer_service: State<'_, TransferService>,
    ssh_sessions: State<'_, SshSessionService>,
    serial_service: State<'_, SerialService>,
    tcp_terminals: State<'_, TcpTerminalService>,
    logs: State<'_, LogService>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    let closed_terminals = collect_cleanup_result(
        "terminal sessions",
        terminal_service.close_by_connection(&connection_id),
        &mut errors,
    );
    let closed_local_ptys = collect_cleanup_result(
        "local ptys",
        local_shells.close_ptys_by_connection(&connection_id),
        &mut errors,
    );
    let closed_ssh_ptys = collect_cleanup_result(
        "ssh ptys",
        ssh_sessions.close_ptys_by_connection(&connection_id).await,
        &mut errors,
    );
    let closed_file_sessions = collect_cleanup_result(
        "file transfer sessions",
        file_transfer_service.close_by_connection(&connection_id),
        &mut errors,
    );
    let cancelled_transfers = collect_cleanup_result(
        "transfers",
        transfer_service.cancel_by_connection(&connection_id),
        &mut errors,
    );
    let closed_ssh_session = collect_cleanup_result(
        "ssh transport",
        ssh_sessions.close(&connection_id).await,
        &mut errors,
    );
    let closed_serial_terminals = collect_cleanup_result(
        "serial terminals",
        serial_service.close_by_connection(&connection_id),
        &mut errors,
    );
    let closed_tcp_terminals = collect_cleanup_result(
        "tcp terminals",
        tcp_terminals.close_by_connection(&connection_id),
        &mut errors,
    );
    collect_cleanup_result(
        "connection registry",
        manager.close(&connection_id),
        &mut errors,
    );
    let _ = logs.record(
        LogLevel::Info,
        "connection",
        format!(
            "closed {connection_id}; released {closed_terminals} terminals, {closed_local_ptys} local ptys, {closed_ssh_ptys} ssh ptys, {closed_serial_terminals} serial terminals, {closed_tcp_terminals} tcp terminals, {closed_file_sessions} file sessions, cancelled {cancelled_transfers} transfers, closed ssh session: {closed_ssh_session}"
        ),
    );
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "connection cleanup completed with errors: {}",
            errors.join("; ")
        ))
    }
}

fn collect_cleanup_result<T: Default>(
    name: &str,
    result: Result<T, String>,
    errors: &mut Vec<String>,
) -> T {
    match result {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("{name}: {error}"));
            T::default()
        }
    }
}

#[tauri::command]
pub async fn ssh_authenticate_password(
    connection_id: String,
    password: String,
    manager: State<'_, ConnectionManager>,
    ssh_sessions: State<'_, SshSessionService>,
    logs: State<'_, LogService>,
) -> Result<ConnectionSession, String> {
    authenticate_ssh_password(
        &connection_id,
        password,
        manager.inner(),
        ssh_sessions.inner(),
        logs.inner(),
    )
    .await
}

#[tauri::command]
pub async fn ssh_authenticate_saved_password(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
    profiles: State<'_, ProfileStore>,
    secrets: State<'_, SecretStore>,
    ssh_sessions: State<'_, SshSessionService>,
    logs: State<'_, LogService>,
) -> Result<ConnectionSession, String> {
    let session = manager
        .get(&connection_id)?
        .ok_or_else(|| format!("connection not found: {connection_id}"))?;
    let profile = profiles
        .get(&session.profile_id)?
        .ok_or_else(|| format!("profile not found: {}", session.profile_id))?;
    if !matches!(profile.r#type, ConnectionType::Ssh | ConnectionType::Sftp)
        || profile.auth_type.as_deref() != Some("password")
    {
        return Err("保存的 SSH 密码只能用于密码认证配置".to_string());
    }
    ssh_sessions.ensure_matches_profile(&connection_id, &profile)?;

    let profile_id = session.profile_id;
    let credential_profile_id = profile_id.clone();
    let secret_store = secrets.inner().clone();
    let read_task = tauri::async_runtime::spawn_blocking(move || {
        secret_store.get_secret(&credential_profile_id, SecretPurpose::Password)
    });
    let password = match tokio::time::timeout(
        Duration::from_secs(SAVED_CREDENTIAL_READ_TIMEOUT_SECS),
        read_task,
    )
    .await
    {
        Err(_) => {
            let error = format!(
                "读取已保存的 SSH 凭据超时（{} 秒）。请检查系统凭据库授权窗口，或重新输入密码",
                SAVED_CREDENTIAL_READ_TIMEOUT_SECS
            );
            record_saved_credential_failure(logs.inner(), &profile_id, &error);
            return Err(error);
        }
        Ok(Err(join_error)) => {
            let error = format!("系统凭据库任务执行失败：{join_error}");
            record_saved_credential_failure(logs.inner(), &profile_id, &error);
            return Err(error);
        }
        Ok(Ok(Err(read_error))) => {
            record_saved_credential_failure(logs.inner(), &profile_id, &read_error);
            return Err(read_error);
        }
        Ok(Ok(Ok(None))) => {
            let error = "未找到已保存的 SSH 密码，请重新输入".to_string();
            record_saved_credential_failure(logs.inner(), &profile_id, &error);
            return Err(error);
        }
        Ok(Ok(Ok(Some(password)))) => password,
    };

    authenticate_ssh_password(
        &connection_id,
        password,
        manager.inner(),
        ssh_sessions.inner(),
        logs.inner(),
    )
    .await
}

fn record_saved_credential_failure(logs: &LogService, profile_id: &str, error: &str) {
    let _ = logs.record(
        LogLevel::Warn,
        "credential",
        format!("saved credential access failed for profile {profile_id}: {error}"),
    );
}

async fn authenticate_ssh_password(
    connection_id: &str,
    password: String,
    manager: &ConnectionManager,
    ssh_sessions: &SshSessionService,
    logs: &LogService,
) -> Result<ConnectionSession, String> {
    let outcome = ssh_sessions
        .authenticate_password(connection_id, password)
        .await?;
    let session = manager.mark_ssh_authenticated(connection_id, false)?;
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
