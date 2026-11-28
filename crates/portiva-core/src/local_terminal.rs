//! Native local PTYs share the SSH terminal's input and output contract.
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{Client, CoreEvent, SessionId, TerminalHandle, TerminalSize, client::TerminalCommand};

#[derive(Clone, Debug)]
pub struct LocalShell {
    program: PathBuf,
    arguments: Vec<OsString>,
    label: String,
}

impl LocalShell {
    pub fn detect() -> Result<Self> {
        #[cfg(windows)]
        {
            let windows = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
            let powershell = windows.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
            let pwsh = std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .map(|path| path.join(r"PowerShell\7\pwsh.exe"));
            let program = find_executable("pwsh.exe")
                .or_else(|| pwsh.filter(|path| path.is_file()))
                .or_else(|| powershell.is_file().then_some(powershell))
                .or_else(|| find_executable("powershell.exe"))
                .or_else(|| {
                    std::env::var_os("COMSPEC")
                        .map(PathBuf::from)
                        .filter(|path| path.is_file())
                })
                .or_else(|| {
                    let path = windows.join(r"System32\cmd.exe");
                    path.is_file().then_some(path)
                })
                .context("找不到 PowerShell 或 CMD")?;
            let is_cmd = program
                .file_stem()
                .is_some_and(|name| name.eq_ignore_ascii_case("cmd"));
            Ok(Self {
                program,
                arguments: if is_cmd {
                    vec!["/Q".into()]
                } else {
                    vec!["-NoLogo".into()]
                },
                label: if is_cmd {
                    "CMD".into()
                } else {
                    "PowerShell".into()
                },
            })
        }
        #[cfg(unix)]
        {
            // portable-pty checks $SHELL, the account database, and /bin/sh.
            let program = PathBuf::from(CommandBuilder::new_default_prog().get_shell());
            let label = program
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            Ok(Self {
                program,
                arguments: vec!["-l".into()],
                label,
            })
        }
    }

    pub fn title(&self) -> String {
        format!("本地 · {}", self.label)
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    fn command(&self, directory: &Path) -> CommandBuilder {
        let mut command = CommandBuilder::new(&self.program);
        command.args(&self.arguments);
        command.cwd(directory);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Portiva2");
        command
    }
}

#[cfg(windows)]
fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows.clamp(1, i16::MAX as u16),
        cols: size.columns.clamp(2, i16::MAX as u16),
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl Client {
    pub async fn open_local_terminal(
        &self,
        session_id: SessionId,
        shell: LocalShell,
        directory: PathBuf,
        size: TerminalSize,
    ) -> Result<TerminalHandle> {
        let command = shell.command(&directory);
        let (master, mut reader, mut writer, mut child) = tokio::task::spawn_blocking(move || {
            anyhow::ensure!(directory.is_dir(), "本地终端的工作目录不存在");
            let pair = native_pty_system()
                .openpty(pty_size(size))
                .context("无法分配本地 PTY")?;
            // Prepare I/O before spawning so an initialization error never orphans a shell.
            let reader = pair.master.try_clone_reader()?;
            let writer = pair.master.take_writer()?;
            let child = pair
                .slave
                .spawn_command(command)
                .context("无法启动本地 Shell")?;
            drop(pair.slave);
            Ok::<_, anyhow::Error>((pair.master, reader, writer, child))
        })
        .await??;
        let id = Uuid::new_v4();
        let closed = CancellationToken::new();
        self.inner
            .local_terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, (session_id, closed.clone()));
        let (sender, mut commands) = mpsc::channel(1024);
        let weak_sender = sender.downgrade();
        let activated = Arc::new(Notify::new());
        let ready = activated.clone();
        let (input_done_tx, mut input_done) = oneshot::channel();
        tokio::task::spawn_blocking(move || {
            let result = (|| -> Result<()> {
                while let Some(command) = commands.blocking_recv() {
                    match command {
                        TerminalCommand::Activate => ready.notify_one(),
                        TerminalCommand::Write(bytes) => {
                            writer.write_all(&bytes)?;
                            writer.flush()?;
                        }
                        TerminalCommand::Resize(size) => master.resize(pty_size(size))?,
                        TerminalCommand::Close => break,
                    }
                }
                Ok(())
            })();
            // Closing the master releases ConPTY's output pipe after its final bytes.
            drop(writer);
            drop(master);
            let _ = input_done_tx.send(result);
        });
        let (output_tx, mut output) = mpsc::channel(32);
        tokio::task::spawn_blocking(move || {
            let mut bytes = [0u8; 16384];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => {
                        if output_tx
                            .blocking_send(Ok(bytes[..count].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    // Unix PTYs can signal slave closure as EIO instead of EOF.
                    #[cfg(unix)]
                    Err(error) if error.raw_os_error() == Some(5) => break,
                    Err(error) => {
                        let _ = output_tx.blocking_send(Err(error));
                        break;
                    }
                }
            }
        });
        let events = self.inner.events.clone();
        let inner = self.inner.clone();
        let cancelled = closed.clone();
        tokio::spawn(async move {
            let mut exited = false;
            let mut status = "本地终端已关闭".to_string();
            let active = tokio::select! {
                _ = cancelled.cancelled() => false,
                _ = activated.notified() => true,
                _ = &mut input_done => false,
            };
            let mut poll = tokio::time::interval(std::time::Duration::from_millis(100));
            if active {
                loop {
                    tokio::select! {
                        _ = cancelled.cancelled() => break,
                        result = &mut input_done => {
                            if let Ok(Err(error)) = result { status = format!("本地终端输入失败：{error:#}"); }
                            break;
                        }
                        _ = poll.tick() => {
                            match child.try_wait() {
                                Ok(Some(exit)) => {
                                    exited = true;
                                    status = format!("本地 Shell 已退出（{}）", exit.exit_code());
                                    break;
                                }
                                Ok(None) => {}
                                Err(error) => { status = format!("本地 Shell 状态读取失败：{error}"); break; }
                            }
                        }
                        data = output.recv() => match data {
                            Some(Ok(data)) => {
                                tokio::select! {
                                    _ = cancelled.cancelled() => break,
                                    result = events.send(CoreEvent::TerminalOutput { terminal_id: id, data }) => if result.is_err() { break; },
                                }
                            }
                            Some(Err(error)) => { status = format!("本地终端读取失败：{error}"); break; }
                            None => {
                                if let Ok(Some(exit)) = child.try_wait() {
                                    exited = true;
                                    status = format!("本地 Shell 已退出（{}）", exit.exit_code());
                                }
                                break;
                            }
                        }
                    }
                }
            }
            let reap_child = async {
                // Keep the unreaped child until cleanup; a recycled Unix PID is never signalled.
                if !exited {
                    let _ = tokio::task::spawn_blocking(move || {
                        let _ = child.kill();
                        child.wait()
                    })
                    .await;
                }
            };
            let close_input = async {
                if let Some(sender) = weak_sender.upgrade() {
                    let _ = sender.send(TerminalCommand::Close).await;
                }
            };
            let drain_output = async {
                let mut forward = active && !cancelled.is_cancelled();
                // Drain throughout child exit and master closure: a full PTY output
                // buffer can otherwise prevent either operation from completing.
                while let Some(data) = output.recv().await {
                    if forward && let Ok(data) = data {
                        forward = tokio::select! {
                            _ = cancelled.cancelled() => false,
                            result = events.send(CoreEvent::TerminalOutput { terminal_id: id, data }) => result.is_ok(),
                        };
                    }
                }
            };
            tokio::join!(reap_child, close_input, drain_output);
            cancelled.cancel();
            inner
                .local_terminals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            let _ = events
                .send(CoreEvent::TerminalClosed {
                    terminal_id: id,
                    message: status,
                })
                .await;
        });
        Ok(TerminalHandle {
            id,
            session_id,
            sender,
            closed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Store,
        terminal::{TerminalModel, TerminalSignal},
    };
    use std::time::Duration;

    fn test_shell() -> Result<LocalShell> {
        let mut shell = LocalShell::detect()?;
        #[cfg(windows)]
        if shell.label == "PowerShell" {
            shell.arguments.push("-NoProfile".into());
        }
        #[cfg(unix)]
        {
            shell.program = "/bin/sh".into();
            shell.arguments.clear();
            shell.label = "sh".into();
        }
        Ok(shell)
    }

    fn print(shell: &LocalShell, suffix: &str) -> String {
        if shell.label == "PowerShell" {
            format!("Write-Output ('PORTIVA_' + '{suffix}')\r")
        } else if shell.label == "CMD" {
            format!("@echo PORTIVA_{suffix}\r")
        } else {
            format!("printf '%s%s\\n' 'PORTIVA_' '{suffix}'\r")
        }
    }

    async fn read_until(
        receiver: &async_channel::Receiver<CoreEvent>,
        handle: &TerminalHandle,
        model: &mut TerminalModel,
        needle: &str,
    ) -> Result<()> {
        let mut captured = String::new();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match receiver.recv().await? {
                    CoreEvent::TerminalOutput { terminal_id, data } if terminal_id == handle.id => {
                        if captured.len() < 8000 {
                            captured.push_str(&String::from_utf8_lossy(&data));
                        }
                        for signal in model.feed(&data) {
                            if let TerminalSignal::Write(bytes) = signal {
                                handle.write(bytes)?;
                            }
                        }
                        let text: String = model
                            .snapshot()
                            .cells
                            .iter()
                            .map(|cell| cell.text.as_str())
                            .collect();
                        if text.contains(needle) || captured.contains(needle) {
                            return Ok(());
                        }
                    }
                    CoreEvent::TerminalClosed {
                        terminal_id,
                        message,
                    } if terminal_id == handle.id => anyhow::bail!("终端提前退出：{message}"),
                    _ => {}
                }
            }
        })
        .await
        .with_context(|| format!("等待本地终端输出 {needle:?} 超时；收到 {captured:?}"))?
    }

    async fn closed(
        receiver: &async_channel::Receiver<CoreEvent>,
        id: crate::TerminalId,
    ) -> Result<String> {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let CoreEvent::TerminalClosed {
                    terminal_id,
                    message,
                } = receiver.recv().await?
                    && terminal_id == id
                {
                    return Ok(message);
                }
            }
        })
        .await
        .context("本地终端未及时清理")?
    }

    #[tokio::test]
    async fn native_shell_unicode_resize_and_exit() -> Result<()> {
        let data = tempfile::tempdir()?;
        let directory = data.path().join("local shell 中文");
        std::fs::create_dir(&directory)?;
        let (client, events) = Client::new(Store::open(data.path())?);
        let shell = test_shell()?;
        let handle = client
            .open_local_terminal(
                Uuid::new_v4(),
                shell.clone(),
                directory.clone(),
                TerminalSize::default(),
            )
            .await?;
        assert!(
            tokio::time::timeout(Duration::from_millis(80), events.recv())
                .await
                .is_err(),
            "输出必须等 consumer activate 后再发送"
        );
        let size = TerminalSize {
            columns: 110,
            rows: 42,
        };
        let mut model = TerminalModel::new(size);
        handle.activate()?;
        handle.resize(size)?;
        handle.write(print(&shell, "LOCAL_你好"))?;
        read_until(&events, &handle, &mut model, "PORTIVA_LOCAL_你好").await?;
        let command = if shell.label == "PowerShell" {
            "Write-Output (Get-Location).Path\r"
        } else if shell.label == "CMD" {
            "@cd\r"
        } else {
            "pwd\r"
        };
        handle.write(command)?;
        read_until(&events, &handle, &mut model, "local shell 中文").await?;
        if shell.label == "PowerShell" {
            handle.write(
                "Write-Output ('SIZE_' + [Console]::WindowWidth + '_' + [Console]::WindowHeight)\r",
            )?;
            read_until(&events, &handle, &mut model, "SIZE_110_42").await?;
        }
        handle.write("exit 7\r")?;
        let message = closed(&events, handle.id).await?;
        assert!(message.contains('7'), "{message}");
        assert!(handle.write("ignored").is_err());
        assert!(handle.activate().is_err());
        assert!(handle.resize(size).is_err());
        client.shutdown().await;
        Ok(())
    }

    #[tokio::test]
    async fn closing_unactivated_and_busy_shells_preserves_siblings() -> Result<()> {
        let data = tempfile::tempdir()?;
        let (client, events) = Client::new(Store::open(data.path())?);
        let shell = test_shell()?;
        let pending = client
            .open_local_terminal(
                Uuid::new_v4(),
                shell.clone(),
                data.path().into(),
                TerminalSize::default(),
            )
            .await?;
        pending.close();
        assert!(pending.write("ignored").is_err());
        assert!(pending.activate().is_err());
        assert!(pending.resize(TerminalSize::default()).is_err());
        closed(&events, pending.id)
            .await
            .context("关闭未激活的本地 Shell")?;
        let active = client
            .open_local_terminal(
                Uuid::new_v4(),
                shell.clone(),
                data.path().into(),
                TerminalSize::default(),
            )
            .await?;
        let sibling = client
            .open_local_terminal(
                Uuid::new_v4(),
                shell.clone(),
                data.path().into(),
                TerminalSize::default(),
            )
            .await?;
        active.activate()?;
        // More output than both bounded queues can hold must remain cancellable.
        let burst = if shell.label == "PowerShell" {
            "while ($true) { Write-Output ('x' * 2000) }\r"
        } else if shell.label == "CMD" {
            "@for /L %i in (1,1,9999999) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r"
        } else {
            "while :; do printf '%02000d\\n' 0; done\r"
        };
        active.write(burst)?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        active.close();
        closed(&events, active.id)
            .await
            .context("关闭持续输出的本地 Shell")?;
        sibling.activate()?;
        sibling.write(print(&shell, "SIBLING_OK"))?;
        read_until(
            &events,
            &sibling,
            &mut TerminalModel::new(TerminalSize::default()),
            "PORTIVA_SIBLING_OK",
        )
        .await?;
        let id = sibling.id;
        drop(sibling);
        closed(&events, id).await.context("关闭兄弟本地 Shell")?;
        assert!(client.inner.local_terminals.lock().unwrap().is_empty());
        Ok(())
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cmd_fallback_uses_the_same_pty_contract() -> Result<()> {
        let data = tempfile::tempdir()?;
        let (client, events) = Client::new(Store::open(data.path())?);
        let shell = LocalShell {
            program: PathBuf::from(std::env::var_os("SystemRoot").context("SystemRoot")?)
                .join(r"System32\cmd.exe"),
            arguments: vec!["/D".into(), "/Q".into()],
            label: "CMD".into(),
        };
        let handle = client
            .open_local_terminal(
                Uuid::new_v4(),
                shell.clone(),
                data.path().into(),
                TerminalSize::default(),
            )
            .await?;
        handle.activate()?;
        handle.write(print(&shell, "CMD_OK"))?;
        read_until(
            &events,
            &handle,
            &mut TerminalModel::new(TerminalSize::default()),
            "PORTIVA_CMD_OK",
        )
        .await?;
        client.shutdown().await;
        closed(&events, handle.id).await?;
        Ok(())
    }
}
