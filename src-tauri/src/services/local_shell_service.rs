use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize, PtySystem,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::terminal::{TerminalRenderPolicy, TerminalSessionStatus, TerminalSize};
use crate::services::terminal_service::{
    drain_utf8_terminal_output, terminal_disconnect_notice, TerminalService,
};

const TERMINAL_SNAPSHOT_EVENT: &str = "portiva://terminal-snapshot";
const TERMINAL_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    terminal_id: String,
    status: TerminalSessionStatus,
    buffered_bytes: usize,
    buffer_preview: String,
    render_policy: TerminalRenderPolicy,
    output_chunk: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalShellInfo {
    pub shell_label: String,
}

#[derive(Default)]
pub struct LocalShellService {
    sessions: Mutex<HashMap<String, LocalShellSession>>,
}

struct LocalShellSession {
    connection_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child_killer: Box<dyn ChildKiller + Send + Sync>,
}

struct ShellCandidate {
    program: String,
    args: Vec<String>,
    label: String,
}

impl LocalShellService {
    pub fn open(
        &self,
        connection_id: &str,
        terminal_id: &str,
        size: &TerminalSize,
        app_handle: AppHandle,
    ) -> Result<LocalShellInfo, String> {
        if self.has_pty(connection_id, terminal_id)? {
            return Ok(LocalShellInfo {
                shell_label: "Shell".to_string(),
            });
        }

        let pty_system = native_pty_system();
        let candidates = local_shell_candidates();
        let mut last_error = None;

        for candidate in candidates {
            match spawn_local_shell(&*pty_system, &candidate, size) {
                Ok(spawned) => {
                    let SpawnedLocalShell {
                        master,
                        writer,
                        reader,
                        child,
                    } = spawned;
                    let child_killer = child.clone_killer();

                    spawn_local_shell_reader(app_handle.clone(), terminal_id.to_string(), reader);

                    self.sessions
                        .lock()
                        .map_err(|_| "local shell service lock poisoned".to_string())?
                        .insert(
                            terminal_id.to_string(),
                            LocalShellSession {
                                connection_id: connection_id.to_string(),
                                master,
                                writer: Arc::new(Mutex::new(writer)),
                                child_killer,
                            },
                        );
                    spawn_local_shell_exit_watcher(app_handle, terminal_id.to_string(), child);

                    return Ok(LocalShellInfo {
                        shell_label: candidate.label,
                    });
                }
                Err(error) => {
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| "未找到可启动的本地 shell".to_string()))
    }

    pub fn write_pty(
        &self,
        connection_id: &str,
        terminal_id: &str,
        data: &str,
    ) -> Result<(), String> {
        let writer = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "local shell service lock poisoned".to_string())?;
            let session = sessions
                .get(terminal_id)
                .filter(|session| session.connection_id == connection_id)
                .ok_or_else(|| format!("local shell PTY not found: {terminal_id}"))?;

            Arc::clone(&session.writer)
        };

        let mut writer = writer
            .lock()
            .map_err(|_| "local shell writer lock poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write local shell PTY data: {error}"))
    }

    pub fn resize_pty(
        &self,
        connection_id: &str,
        terminal_id: &str,
        size: &TerminalSize,
    ) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "local shell service lock poisoned".to_string())?;
        let session = sessions
            .get(terminal_id)
            .filter(|session| session.connection_id == connection_id)
            .ok_or_else(|| format!("local shell PTY not found: {terminal_id}"))?;

        session
            .master
            .resize(to_pty_size(size))
            .map_err(|error| format!("failed to resize local shell PTY: {error}"))
    }

    pub fn close_pty(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "local shell service lock poisoned".to_string())?
            .remove(terminal_id);

        let Some(mut session) = session else {
            return Ok(false);
        };

        if session.connection_id != connection_id {
            self.sessions
                .lock()
                .map_err(|_| "local shell service lock poisoned".to_string())?
                .insert(terminal_id.to_string(), session);
            return Ok(false);
        }

        let _ = session.child_killer.kill();
        Ok(true)
    }

    pub fn close_ptys_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "local shell service lock poisoned".to_string())?;
        let terminal_ids = sessions
            .iter()
            .filter_map(|(terminal_id, session)| {
                (session.connection_id == connection_id).then(|| terminal_id.clone())
            })
            .collect::<Vec<_>>();

        for terminal_id in &terminal_ids {
            if let Some(mut session) = sessions.remove(terminal_id) {
                let _ = session.child_killer.kill();
            }
        }

        Ok(terminal_ids.len())
    }

    pub fn close_pty_by_terminal(&self, terminal_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "local shell service lock poisoned".to_string())?
            .remove(terminal_id);

        let Some(mut session) = session else {
            return Ok(false);
        };

        let _ = session.child_killer.kill();
        Ok(true)
    }

    pub fn has_pty(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "local shell service lock poisoned".to_string())?
            .get(terminal_id)
            .map(|session| session.connection_id == connection_id)
            .unwrap_or(false))
    }
}

struct SpawnedLocalShell {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn spawn_local_shell(
    pty_system: &dyn PtySystem,
    candidate: &ShellCandidate,
    size: &TerminalSize,
) -> Result<SpawnedLocalShell, String> {
    let pair = pty_system
        .openpty(to_pty_size(size))
        .map_err(|error| format!("failed to open local PTY: {error}"))?;
    let mut command = CommandBuilder::new(&candidate.program);

    command.args(candidate.args.iter().map(String::as_str));
    command.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        command.env("HOME", &home);
        command.env("USERPROFILE", &home);
        command.cwd(&home);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start local shell {}: {error}", candidate.program))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to attach local shell reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to attach local shell writer: {error}"))?;

    Ok(SpawnedLocalShell {
        master: pair.master,
        writer,
        reader,
        child,
    })
}

fn spawn_local_shell_reader(
    app_handle: AppHandle,
    terminal_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending_bytes = Vec::new();
        let mut last_flush = Instant::now()
            .checked_sub(TERMINAL_OUTPUT_FLUSH_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut disconnect_reason = "本地终端进程已退出".to_string();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(byte_count) => {
                    pending_bytes.extend_from_slice(&buffer[..byte_count]);
                    if should_flush_local_shell_output_after_read(
                        pending_bytes.len(),
                        last_flush,
                        TERMINAL_OUTPUT_FLUSH_INTERVAL,
                    ) {
                        flush_terminal_output(
                            &app_handle,
                            &terminal_id,
                            &mut pending_bytes,
                            &mut last_flush,
                            false,
                        );
                    }
                }
                Err(error) => {
                    flush_terminal_output(
                        &app_handle,
                        &terminal_id,
                        &mut pending_bytes,
                        &mut last_flush,
                        true,
                    );
                    disconnect_reason = format!("读取本地终端输出失败：{error}");
                    break;
                }
            }
        }

        flush_terminal_output(
            &app_handle,
            &terminal_id,
            &mut pending_bytes,
            &mut last_flush,
            true,
        );
        emit_terminal_disconnected(&app_handle, &terminal_id, &disconnect_reason);
        let local_shells = app_handle.state::<LocalShellService>();
        let _ = local_shells.close_pty_by_terminal(&terminal_id);
    });
}

fn should_flush_local_shell_output_after_read(
    pending_byte_count: usize,
    _last_flush: Instant,
    _flush_interval: Duration,
) -> bool {
    pending_byte_count > 0
}

fn spawn_local_shell_exit_watcher(
    app_handle: AppHandle,
    terminal_id: String,
    mut child: Box<dyn Child + Send + Sync>,
) {
    thread::spawn(move || {
        let disconnect_reason = match child.wait() {
            Ok(status) if status.success() => "本地终端进程已退出".to_string(),
            Ok(status) => {
                if let Some(signal) = status.signal() {
                    format!("本地终端进程已退出：{signal}")
                } else {
                    format!("本地终端进程已退出，退出码 {}", status.exit_code())
                }
            }
            Err(error) => format!("等待本地终端进程退出失败：{error}"),
        };

        emit_terminal_disconnected(&app_handle, &terminal_id, &disconnect_reason);
        let local_shells = app_handle.state::<LocalShellService>();
        let _ = local_shells.close_pty_by_terminal(&terminal_id);
    });
}

fn flush_terminal_output(
    app_handle: &AppHandle,
    terminal_id: &str,
    pending_bytes: &mut Vec<u8>,
    last_flush: &mut Instant,
    force: bool,
) {
    if pending_bytes.is_empty() {
        return;
    }

    let output = drain_utf8_terminal_output(pending_bytes, force);
    if output.is_empty() {
        return;
    }

    *last_flush = Instant::now();
    emit_terminal_snapshot(app_handle, terminal_id, &output);
}

fn emit_terminal_snapshot(app_handle: &AppHandle, terminal_id: &str, output: &str) {
    if output.is_empty() {
        return;
    }

    let terminal_service = app_handle.state::<TerminalService>();
    if let Ok(metadata) = terminal_service.append_output_metadata(terminal_id, output) {
        let _ = app_handle.emit(
            TERMINAL_SNAPSHOT_EVENT,
            TerminalOutputEvent {
                terminal_id: terminal_id.to_string(),
                status: metadata.status,
                buffered_bytes: metadata.buffered_bytes,
                buffer_preview: String::new(),
                render_policy: metadata.render_policy,
                output_chunk: output.to_string(),
            },
        );
    }
}

fn emit_terminal_disconnected(app_handle: &AppHandle, terminal_id: &str, reason: &str) {
    let terminal_service = app_handle.state::<TerminalService>();
    if terminal_service
        .append_disconnect_notice(terminal_id, reason)
        .is_err()
    {
        return;
    }

    if let Ok(snapshot) = terminal_service.snapshot(terminal_id) {
        let output = terminal_disconnect_notice(reason);
        let _ = app_handle.emit(
            TERMINAL_SNAPSHOT_EVENT,
            TerminalOutputEvent {
                terminal_id: snapshot.terminal_id,
                status: snapshot.status,
                buffered_bytes: snapshot.buffered_bytes,
                buffer_preview: snapshot.buffer_preview,
                render_policy: snapshot.render_policy,
                output_chunk: output,
            },
        );
    }
}

fn to_pty_size(size: &TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows.max(1),
        cols: size.cols.max(1),
        pixel_width: size.width_px,
        pixel_height: size.height_px,
    }
}

fn local_shell_candidates() -> Vec<ShellCandidate> {
    let mut candidates = Vec::new();

    #[cfg(windows)]
    {
        candidates.push(ShellCandidate {
            program: "pwsh.exe".to_string(),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NoExit".to_string(),
            ],
            label: "PowerShell".to_string(),
        });
        candidates.push(ShellCandidate {
            program: "powershell.exe".to_string(),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NoExit".to_string(),
            ],
            label: "Windows PowerShell".to_string(),
        });
        candidates.push(ShellCandidate {
            program: "cmd.exe".to_string(),
            args: Vec::new(),
            label: "Command Prompt".to_string(),
        });
    }

    #[cfg(not(windows))]
    {
        if let Ok(shell) = env::var("SHELL") {
            if !shell.trim().is_empty() {
                candidates.push(ShellCandidate {
                    label: shell_label(&shell),
                    program: shell,
                    args: Vec::new(),
                });
            }
        }

        #[cfg(target_os = "macos")]
        {
            push_unique_shell(&mut candidates, "/bin/zsh", "zsh");
        }

        push_unique_shell(&mut candidates, "/bin/bash", "bash");
        push_unique_shell(&mut candidates, "/bin/sh", "sh");
    }

    candidates
}

#[cfg(not(windows))]
fn push_unique_shell(candidates: &mut Vec<ShellCandidate>, program: &str, label: &str) {
    if candidates
        .iter()
        .any(|candidate| candidate.program == program)
    {
        return;
    }

    candidates.push(ShellCandidate {
        program: program.to_string(),
        args: Vec::new(),
        label: label.to_string(),
    });
}

#[cfg(not(windows))]
fn shell_label(shell: &str) -> String {
    shell
        .rsplit('/')
        .next()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Shell")
        .to_string()
}

fn home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        let profile = env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty());

        profile.or_else(|| {
            let drive = env::var("HOMEDRIVE").ok()?;
            let path = env::var("HOMEPATH").ok()?;
            let home = format!("{drive}{path}");

            (!home.trim().is_empty()).then_some(home)
        })
    }

    #[cfg(not(windows))]
    {
        env::var("HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_shell_flushes_each_read_so_prompt_is_not_stuck_pending() {
        let just_flushed = Instant::now();

        assert!(should_flush_local_shell_output_after_read(
            32,
            just_flushed,
            TERMINAL_OUTPUT_FLUSH_INTERVAL,
        ));
    }
}
