use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{oneshot, watch},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    client::remote_entries,
    files::{local_child, remote_join},
    *,
};

pub(crate) struct TransferControl {
    snapshot: Mutex<TransferSnapshot>,
    paused: watch::Sender<bool>,
    cancelled: CancellationToken,
    started: AtomicBool,
}

impl TransferControl {
    pub(crate) fn cancel(&self) {
        self.cancelled.cancel();
    }
    fn snapshot(&self) -> TransferSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn update(&self, update: impl FnOnce(&mut TransferSnapshot)) -> TransferSnapshot {
        let mut state = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        update(&mut state);
        state.clone()
    }
}

impl Client {
    pub fn transfers(&self) -> Vec<TransferSnapshot> {
        self.inner
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|t| t.snapshot())
            .collect()
    }

    pub async fn pause_transfer(&self, id: TransferId, paused: bool) -> Result<()> {
        let control = self.transfer(id)?;
        let state = control.snapshot();
        anyhow::ensure!(!state.status.finished(), "传输任务已经结束");
        control.paused.send_replace(paused);
        let snapshot = control.update(|s| {
            s.status = if paused {
                TransferStatus::Paused
            } else if control.started.load(Ordering::Acquire) {
                TransferStatus::Running
            } else {
                TransferStatus::Queued
            }
        });
        let _ = self.inner.events.send(CoreEvent::Transfer(snapshot)).await;
        Ok(())
    }

    pub fn cancel_transfer(&self, id: TransferId) -> Result<()> {
        self.transfer(id)?.cancelled.cancel();
        Ok(())
    }

    pub fn forget_transfer(&self, id: TransferId) -> Result<()> {
        let mut transfers = self
            .inner
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(control) = transfers.get(&id) {
            anyhow::ensure!(
                control.snapshot().status.finished(),
                "请先取消传输再移除记录"
            );
        }
        transfers.remove(&id);
        Ok(())
    }

    pub async fn retry_transfer(&self, id: TransferId) -> Result<TransferId> {
        let state = self.transfer(id)?.snapshot();
        anyhow::ensure!(state.status.finished(), "任务还未结束");
        self.enqueue_transfer(
            state.session_id,
            state.direction,
            state.source,
            state.destination,
        )
        .await
    }

    pub async fn upload(
        &self,
        id: SessionId,
        local_path: PathBuf,
        remote_directory: String,
    ) -> Result<TransferId> {
        let name = local_path
            .file_name()
            .and_then(|s| s.to_str())
            .context("本地路径没有可传输的文件名")?;
        crate::files::validate_name(name)?;
        self.enqueue_transfer(
            id,
            TransferDirection::Upload,
            local_path.to_string_lossy().into_owned(),
            remote_join(&remote_directory, name),
        )
        .await
    }

    pub async fn download(
        &self,
        id: SessionId,
        remote_path: String,
        local_directory: PathBuf,
    ) -> Result<TransferId> {
        let local_directory = tokio::fs::canonicalize(local_directory)
            .await
            .context("下载目录不可访问")?;
        let local_directory = dunce::simplified(&local_directory).to_path_buf();
        let name = remote_path
            .rsplit('/')
            .next()
            .context("远程路径没有文件名")?;
        let destination = local_child(&local_directory, name)?
            .to_string_lossy()
            .into_owned();
        self.enqueue_transfer(id, TransferDirection::Download, remote_path, destination)
            .await
    }

    fn transfer(&self, id: TransferId) -> Result<Arc<TransferControl>> {
        self.inner
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .context("传输任务不存在")
    }

    async fn enqueue_transfer(
        &self,
        session_id: SessionId,
        direction: TransferDirection,
        source: String,
        destination: String,
    ) -> Result<TransferId> {
        let session = self.session(session_id)?;
        let id = Uuid::new_v4();
        let name = if direction == TransferDirection::Upload {
            Path::new(&source)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| source.clone())
        } else {
            source.rsplit('/').next().unwrap_or(&source).to_string()
        };
        let (paused, _) = watch::channel(false);
        let control = Arc::new(TransferControl {
            snapshot: Mutex::new(TransferSnapshot {
                id,
                session_id,
                direction,
                name,
                source,
                destination,
                status: TransferStatus::Queued,
                total_bytes: 0,
                transferred_bytes: 0,
                completed_files: 0,
                skipped_files: 0,
                error: None,
            }),
            paused,
            cancelled: CancellationToken::new(),
            started: AtomicBool::new(false),
        });
        self.inner
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, control.clone());
        self.emit_transfer(&control).await;
        let client = self.clone();
        tokio::spawn(async move {
            let result = async {
                let _slot = tokio::select! {
                    _ = control.cancelled.cancelled() => bail!("已取消"),
                    _ = session.cancelled.cancelled() => bail!("连接已断开"),
                    permit = client.inner.transfer_slots.acquire() => permit?,
                };
                let mut pause = control.paused.subscribe();
                wait_ready(&control, &session.cancelled, &mut pause).await?;
                control.started.store(true, Ordering::Release);
                control.update(|s| s.status = TransferStatus::Running);
                client.emit_transfer(&control).await;
                let sftp = tokio::select! {
                    _=control.cancelled.cancelled()=>bail!("已取消"),
                    _=session.cancelled.cancelled()=>bail!("连接已断开"),
                    result=client.new_sftp(session_id)=>result?,
                };
                let work = client
                    .run_transfer(&control, &session.cancelled, &sftp, &mut pause)
                    .await;
                let _ = sftp.close().await;
                work
            }
            .await;
            control.update(|state| {
                if control.cancelled.is_cancelled() || session.cancelled.is_cancelled() {
                    state.status = TransferStatus::Cancelled;
                } else if let Err(error) = result {
                    state.status = TransferStatus::Failed;
                    state.error = Some(format!("{error:#}"));
                } else {
                    state.status = TransferStatus::Completed;
                }
            });
            client.emit_transfer(&control).await;
        });
        Ok(id)
    }

    async fn emit_transfer(&self, control: &TransferControl) {
        let _ = self
            .inner
            .events
            .send(CoreEvent::Transfer(control.snapshot()))
            .await;
    }

    async fn run_transfer(
        &self,
        control: &TransferControl,
        disconnected: &CancellationToken,
        sftp: &SftpSession,
        pause: &mut watch::Receiver<bool>,
    ) -> Result<()> {
        let state = control.snapshot();
        let download_root = Path::new(&state.destination)
            .parent()
            .context("目标没有父目录")?
            .to_path_buf();
        // Planning belongs to the core, including recursive download (formerly React code).
        let mut directories = Vec::new();
        let mut files = Vec::new();
        let mut pending = vec![(state.source.clone(), state.destination.clone())];
        let mut total = 0;
        let mut skipped = 0;
        while let Some((source, destination)) = pending.pop() {
            wait_ready(control, disconnected, pause).await?;
            match state.direction {
                TransferDirection::Upload => {
                    let metadata = tokio::fs::symlink_metadata(&source).await?;
                    if crate::files::is_link(&metadata)
                        || (!metadata.is_dir() && !metadata.is_file())
                    {
                        skipped += 1;
                        continue;
                    }
                    if metadata.is_dir() {
                        directories.push(destination.clone());
                        let mut reader = tokio::fs::read_dir(source).await?;
                        while let Some(entry) = reader.next_entry().await? {
                            let name = entry
                                .file_name()
                                .into_string()
                                .map_err(|_| anyhow::anyhow!("文件名不是有效 UTF-8"))?;
                            crate::files::validate_name(&name)?;
                            pending.push((
                                entry.path().to_string_lossy().into_owned(),
                                remote_join(&destination, &name),
                            ));
                        }
                    } else {
                        total += metadata.len();
                        files.push((source, destination));
                    }
                }
                TransferDirection::Download => {
                    crate::files::check_download_path(&download_root, Path::new(&destination))
                        .await?;
                    let metadata = sftp.symlink_metadata(&source).await?;
                    if metadata.is_symlink() || (!metadata.is_dir() && !metadata.is_regular()) {
                        skipped += 1;
                        continue;
                    }
                    if metadata.is_dir() {
                        directories.push(destination.clone());
                        for entry in remote_entries(sftp, &source).await? {
                            pending.push((
                                entry.path,
                                local_child(Path::new(&destination), &entry.name)?
                                    .to_string_lossy()
                                    .into_owned(),
                            ));
                        }
                    } else {
                        total += metadata.size.unwrap_or(0);
                        files.push((source, destination));
                    }
                }
            }
        }
        control.update(|s| {
            s.total_bytes = total;
            s.skipped_files = skipped;
        });
        self.emit_transfer(control).await;
        for directory in directories {
            wait_ready(control, disconnected, pause).await?;
            match state.direction {
                TransferDirection::Upload => {
                    if sftp.try_exists(&directory).await? {
                        anyhow::ensure!(
                            sftp.metadata(&directory).await?.is_dir(),
                            "目标存在且不是目录：{directory}"
                        );
                    } else {
                        sftp.create_dir(directory).await?;
                    }
                }
                TransferDirection::Download => {
                    crate::files::check_download_path(&download_root, Path::new(&directory))
                        .await?;
                    tokio::fs::create_dir_all(directory).await?;
                }
            }
        }
        for (source, destination) in files {
            wait_ready(control, disconnected, pause).await?;
            match state.direction {
                TransferDirection::Upload => {
                    self.upload_file(control, disconnected, sftp, pause, &source, &destination)
                        .await?
                }
                TransferDirection::Download => {
                    crate::files::check_download_path(&download_root, Path::new(&destination))
                        .await?;
                    self.download_file(control, disconnected, sftp, pause, &source, &destination)
                        .await?;
                }
            }
        }
        Ok(())
    }

    async fn conflict(
        &self,
        control: &TransferControl,
        disconnected: &CancellationToken,
        path: &str,
    ) -> Result<ConflictDecision> {
        control.update(|s| s.status = TransferStatus::WaitingConflict);
        self.emit_transfer(control).await;
        let (response, answer) = oneshot::channel();
        self.inner
            .events
            .send(CoreEvent::TransferConflict {
                transfer_id: control.snapshot().id,
                path: path.into(),
                response,
            })
            .await?;
        let answer = tokio::select! {
            _ = control.cancelled.cancelled() => bail!("已取消"),
            _ = disconnected.cancelled() => bail!("连接已断开"),
            answer = answer => answer.context("冲突确认已关闭")?,
        };
        if answer == ConflictDecision::Cancel {
            control.cancelled.cancel();
            bail!("已取消");
        }
        control.update(|s| {
            s.status = if *control.paused.borrow() {
                TransferStatus::Paused
            } else {
                TransferStatus::Running
            }
        });
        self.emit_transfer(control).await;
        Ok(answer)
    }

    async fn upload_file(
        &self,
        control: &TransferControl,
        disconnected: &CancellationToken,
        sftp: &SftpSession,
        pause: &mut watch::Receiver<bool>,
        source: &str,
        destination: &str,
    ) -> Result<()> {
        let existed = sftp.try_exists(destination).await?;
        if existed
            && self.conflict(control, disconnected, destination).await? == ConflictDecision::Skip
        {
            control.update(|s| s.skipped_files += 1);
            self.emit_transfer(control).await;
            return Ok(());
        }
        let temporary = format!("{destination}.portiva2-{}.part", Uuid::new_v4());
        let result = async {
            let mut local = tokio::fs::File::open(source).await?;
            let mut remote = sftp
                .open_with_flags(
                    &temporary,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
                )
                .await?;
            self.copy(control, disconnected, pause, &mut local, &mut remote)
                .await?;
            remote.flush().await?;
            remote.shutdown().await?;
            drop(remote);
            wait_ready(control, disconnected, pause).await?;
            let exists_now = sftp.try_exists(destination).await?;
            if exists_now
                && !existed
                && self.conflict(control, disconnected, destination).await?
                    == ConflictDecision::Skip
            {
                control.update(|s| s.skipped_files += 1);
                return Ok(());
            }
            if exists_now {
                anyhow::ensure!(
                    !sftp.symlink_metadata(destination).await?.is_dir(),
                    "目标是目录，不能用文件覆盖：{destination}"
                );
                // Retain the old target until the complete temporary file can take its place.
                let backup = format!("{destination}.portiva2-{}.backup", Uuid::new_v4());
                sftp.rename(destination, &backup).await?;
                if let Err(error) = sftp.rename(&temporary, destination).await {
                    sftp.rename(&backup, destination)
                        .await
                        .context("提交失败且原文件恢复失败，原文件保留在 .backup 路径")?;
                    return Err(error.into());
                }
                sftp.remove_file(backup).await?;
            } else {
                sftp.rename(&temporary, destination).await?;
            }
            control.update(|s| s.completed_files += 1);
            Ok(())
        }
        .await;
        let _ = sftp.remove_file(temporary).await;
        self.emit_transfer(control).await;
        result
    }

    async fn download_file(
        &self,
        control: &TransferControl,
        disconnected: &CancellationToken,
        sftp: &SftpSession,
        pause: &mut watch::Receiver<bool>,
        source: &str,
        destination: &str,
    ) -> Result<()> {
        let target = Path::new(destination);
        let existed = tokio::fs::try_exists(target).await?;
        if existed
            && self.conflict(control, disconnected, destination).await? == ConflictDecision::Skip
        {
            control.update(|s| s.skipped_files += 1);
            self.emit_transfer(control).await;
            return Ok(());
        }
        let parent = target.parent().context("下载目标没有父目录")?;
        tokio::fs::create_dir_all(parent).await?;
        let temporary = tempfile::NamedTempFile::new_in(parent)?;
        let mut local = tokio::fs::File::from_std(temporary.reopen()?);
        let mut remote = sftp.open(source).await?;
        self.copy(control, disconnected, pause, &mut remote, &mut local)
            .await?;
        local.flush().await?;
        local.sync_all().await?;
        drop(local);
        drop(remote);
        wait_ready(control, disconnected, pause).await?;
        let exists_now = tokio::fs::try_exists(target).await?;
        if exists_now
            && !existed
            && self.conflict(control, disconnected, destination).await? == ConflictDecision::Skip
        {
            control.update(|s| s.skipped_files += 1);
            self.emit_transfer(control).await;
            return Ok(());
        }
        if exists_now {
            temporary.persist(target).map_err(|e| e.error)?;
        } else {
            temporary.persist_noclobber(target).map_err(|e| e.error)?;
        }
        control.update(|s| s.completed_files += 1);
        self.emit_transfer(control).await;
        Ok(())
    }

    async fn copy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
        &self,
        control: &TransferControl,
        disconnected: &CancellationToken,
        pause: &mut watch::Receiver<bool>,
        reader: &mut R,
        writer: &mut W,
    ) -> Result<()> {
        let mut bytes = vec![0; 128 * 1024];
        let mut last_report = Instant::now();
        loop {
            wait_ready(control, disconnected, pause).await?;
            let count = tokio::select! {
                _ = control.cancelled.cancelled() => bail!("已取消"),
                _ = disconnected.cancelled() => bail!("连接已断开"),
                result = reader.read(&mut bytes) => result?,
            };
            if count == 0 {
                break;
            }
            tokio::select! {
                _ = control.cancelled.cancelled() => bail!("已取消"),
                _ = disconnected.cancelled() => bail!("连接已断开"),
                result = writer.write_all(&bytes[..count]) => result?,
            }
            control.update(|s| s.transferred_bytes += count as u64);
            if last_report.elapsed() >= Duration::from_millis(80) {
                self.emit_transfer(control).await;
                last_report = Instant::now();
            }
        }
        Ok(())
    }
}

async fn wait_ready(
    control: &TransferControl,
    disconnected: &CancellationToken,
    paused: &mut watch::Receiver<bool>,
) -> Result<()> {
    loop {
        anyhow::ensure!(!control.cancelled.is_cancelled(), "已取消");
        anyhow::ensure!(!disconnected.is_cancelled(), "连接已断开");
        if !*paused.borrow_and_update() {
            return Ok(());
        }
        tokio::select! {
            _ = control.cancelled.cancelled() => bail!("已取消"),
            _ = disconnected.cancelled() => bail!("连接已断开"),
            changed = paused.changed() => { changed?; }
        }
    }
}
