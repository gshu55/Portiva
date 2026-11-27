mod support;
use anyhow::{Context as _, Result};
use portiva_core::*;
use sha2::{Digest, Sha256};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

async fn finished(client: &Client, id: TransferId) -> Result<TransferSnapshot> {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(state) = client
                .transfers()
                .into_iter()
                .find(|t| t.id == id && t.status.finished())
            {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .with_context(|| format!("transfer did not finish: {:?}", client.transfers()))
}
fn complete(state: TransferSnapshot) {
    assert_eq!(state.status, TransferStatus::Completed, "{:?}", state.error);
}
fn profile(port: u16) -> Profile {
    Profile {
        host: "127.0.0.1".into(),
        port,
        username: "demo".into(),
        ..Default::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ssh_and_sftp_roundtrip_conflicts_controls_and_channel_isolation() -> Result<()> {
    let server = support::TestServer::start(Duration::from_millis(3)).await?;
    let state = tempfile::tempdir()?;
    let local = tempfile::tempdir()?;
    let (client, events) = Client::new(Store::open(state.path())?);
    let host_prompts = Arc::new(AtomicUsize::new(0));
    let prompts = host_prompts.clone();
    let conflicts = Arc::new(AtomicUsize::new(0));
    let conflict_count = conflicts.clone();
    let policy = Arc::new(AtomicUsize::new(0));
    let decisions = policy.clone();
    let (output, terminal_events) = async_channel::unbounded();
    let pump = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            match event {
                CoreEvent::HostKey(host) => {
                    prompts.fetch_add(1, Ordering::SeqCst);
                    let _ = host.response.send(true);
                }
                CoreEvent::TransferConflict { response, .. } => {
                    conflict_count.fetch_add(1, Ordering::SeqCst);
                    let _ = response.send(if decisions.load(Ordering::SeqCst) == 0 {
                        ConflictDecision::Skip
                    } else {
                        ConflictDecision::Overwrite
                    });
                }
                CoreEvent::TerminalOutput { terminal_id, data } => {
                    let _ = output.send((terminal_id, data)).await;
                }
                _ => {}
            }
        }
    });
    let id = Uuid::new_v4();
    client
        .connect(
            id,
            profile(server.port),
            Credentials::password("portiva-test".into()),
        )
        .await?;
    assert_eq!(host_prompts.load(Ordering::SeqCst), 1);
    let listing = client.list_remote(id, ".").await?;
    assert_eq!(listing.path, "/");
    assert!(
        listing
            .entries
            .iter()
            .any(|e| e.name == "readme.txt" && e.kind == FileKind::File)
    );
    let terminal = client.open_terminal(id, TerminalSize::default()).await?;
    // Register the consumer before activation: even the first banner must arrive intact.
    terminal.activate()?;
    let (terminal_id, banner) =
        tokio::time::timeout(Duration::from_secs(3), terminal_events.recv()).await??;
    assert_eq!(terminal_id, terminal.id);
    assert!(String::from_utf8_lossy(&banner).contains("loopback SSH"));
    let input = "中文\x1b[A\x03".as_bytes().to_vec();
    terminal.write(input.clone())?;
    let (_, echo) = tokio::time::timeout(Duration::from_secs(3), terminal_events.recv()).await??;
    assert_eq!(echo, input);
    terminal.resize(TerminalSize {
        columns: 120,
        rows: 40,
    })?;
    client
        .create_remote_directory(id, "/", "new-folder")
        .await?;
    client.rename_remote(id, "/new-folder", "renamed").await?;
    client.remove_remote(id, "/renamed").await?;
    assert!(client.remove_remote(id, "/").await.is_err());
    let source = local.path().join("project");
    tokio::fs::create_dir_all(source.join("nested/empty")).await?;
    let payload: Vec<u8> = (0..4_200_000).map(|i| (i % 251) as u8).collect();
    tokio::fs::write(source.join("nested/data.bin"), &payload).await?;
    tokio::fs::write(source.join("你好.txt"), "目录上传下载\n").await?;
    complete(
        finished(
            &client,
            client.upload(id, source.clone(), "/".into()).await?,
        )
        .await?,
    );
    let target = local.path().join("downloads");
    tokio::fs::create_dir(&target).await?;
    complete(
        finished(
            &client,
            client
                .download(id, "/project".into(), target.clone())
                .await?,
        )
        .await?,
    );
    assert_eq!(
        Sha256::digest(tokio::fs::read(target.join("project/nested/data.bin")).await?),
        Sha256::digest(&payload)
    );
    assert_eq!(
        tokio::fs::read_to_string(target.join("project/你好.txt")).await?,
        "目录上传下载\n"
    );
    assert!(target.join("project/nested/empty").is_dir());
    tokio::fs::write(source.join("你好.txt"), "updated").await?;
    complete(
        finished(
            &client,
            client
                .upload(id, source.join("你好.txt"), "/project".into())
                .await?,
        )
        .await?,
    );
    assert_ne!(
        tokio::fs::read_to_string(server.root.path().join("project/你好.txt")).await?,
        "updated"
    );
    policy.store(1, Ordering::SeqCst);
    complete(
        finished(
            &client,
            client
                .upload(id, source.join("你好.txt"), "/project".into())
                .await?,
        )
        .await?,
    );
    assert_eq!(
        tokio::fs::read_to_string(server.root.path().join("project/你好.txt")).await?,
        "updated"
    );
    assert!(conflicts.load(Ordering::SeqCst) >= 2);
    // A failed source can be retried after it becomes available.
    let missing = local.path().join("created-later.txt");
    let failed = client.upload(id, missing.clone(), "/".into()).await?;
    assert_eq!(
        finished(&client, failed).await?.status,
        TransferStatus::Failed
    );
    tokio::fs::write(missing, "retry").await?;
    complete(finished(&client, client.retry_transfer(failed).await?).await?);
    client.forget_transfer(failed)?;
    // Pause an in-flight file, browse and use the terminal through other SSH channels, then cancel.
    let large = local.path().join("large.bin");
    tokio::fs::write(&large, vec![0x5a; 8_000_000]).await?;
    let transfer = client.upload(id, large, "/".into()).await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client
                .transfers()
                .iter()
                .any(|s| s.id == transfer && s.transferred_bytes > 0)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    client.pause_transfer(transfer, true).await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = client
        .transfers()
        .into_iter()
        .find(|s| s.id == transfer)
        .unwrap()
        .transferred_bytes;
    tokio::time::timeout(Duration::from_secs(2), client.list_remote(id, "/")).await??;
    terminal.write(b"still responsive".to_vec())?;
    let (_, echo) = tokio::time::timeout(Duration::from_secs(2), terminal_events.recv()).await??;
    assert_eq!(echo, b"still responsive");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        client
            .transfers()
            .into_iter()
            .find(|s| s.id == transfer)
            .unwrap()
            .transferred_bytes,
        before
    );
    client.pause_transfer(transfer, false).await?;
    client.cancel_transfer(transfer)?;
    assert_eq!(
        finished(&client, transfer).await?.status,
        TransferStatus::Cancelled
    );
    assert!(!server.root.path().join("large.bin").exists());
    assert!(
        std::fs::read_dir(server.root.path())?.all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".part"))
    );
    let second = Uuid::new_v4();
    client
        .connect(
            second,
            profile(server.port),
            Credentials::password("portiva-test".into()),
        )
        .await?;
    assert_eq!(
        host_prompts.load(Ordering::SeqCst),
        1,
        "trusted host should not prompt again"
    );
    client.disconnect(second).await?;
    assert!(
        client
            .connect(
                Uuid::new_v4(),
                profile(server.port),
                Credentials::password("wrong".into())
            )
            .await
            .is_err()
    );
    client.remove_remote(id, "/project").await?;
    assert!(!server.root.path().join("project").exists());
    client.disconnect(id).await?;
    assert!(client.list_remote(id, "/").await.is_err());
    pump.abort();
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn key_auth_and_changed_host_rejection() -> Result<()> {
    let server = support::TestServer::start(Duration::ZERO).await?;
    let root = tempfile::tempdir()?;
    let store = Store::open(root.path())?;
    let (client, events) = Client::new(store);
    let pump = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            if let CoreEvent::HostKey(host) = event {
                let _ = host.response.send(true);
            }
        }
    });
    let key_path = root.path().join("test_ed25519");
    server
        .key
        .write_openssh_file(&key_path, russh::keys::ssh_key::LineEnding::LF)?;
    let mut p = profile(server.port);
    p.auth = AuthMethod::PrivateKey;
    p.private_key_path = Some(key_path);
    let id = Uuid::new_v4();
    client.connect(id, p, Credentials::default()).await?;
    client.disconnect(id).await?;
    pump.abort();
    let changed = tempfile::tempdir()?;
    std::fs::write(
        changed.path().join("known_hosts.json"),
        serde_json::to_vec(&std::collections::BTreeMap::from([(
            format!("[127.0.0.1]:{}", server.port),
            "SHA256:changed-test-key",
        )]))?,
    )?;
    let (client, _) = Client::new(Store::open(changed.path())?);
    let error = client
        .connect(
            Uuid::new_v4(),
            profile(server.port),
            Credentials::password("portiva-test".into()),
        )
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("指纹已改变"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_cancels_a_pending_host_confirmation() -> Result<()> {
    let server = support::TestServer::start(Duration::ZERO).await?;
    let data = tempfile::tempdir()?;
    let (client, events) = Client::new(Store::open(data.path())?);
    let id = Uuid::new_v4();
    let task_client = client.clone();
    let port = server.port;
    let task = tokio::spawn(async move {
        task_client
            .connect(
                id,
                profile(port),
                Credentials::password("portiva-test".into()),
            )
            .await
    });
    let question = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let CoreEvent::HostKey(host) = events.recv().await? {
                break Ok::<_, anyhow::Error>(host);
            }
        }
    })
    .await??;
    client.disconnect(id).await?;
    assert!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await??
            .is_err()
    );
    assert!(!data.path().join("known_hosts.json").exists());
    drop(question);
    assert!(client.list_remote(id, "/").await.is_err());
    client.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn split_channels_and_resource_probes_do_not_mix_output_or_disconnect_siblings() -> Result<()>
{
    let server = support::TestServer::start(Duration::ZERO).await?;
    let data = tempfile::tempdir()?;
    let (client, events) = Client::new(Store::open(data.path())?);
    let (output, received) = async_channel::unbounded();
    let pump = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            match event {
                CoreEvent::HostKey(host) => {
                    let _ = host.response.send(true);
                }
                CoreEvent::TerminalOutput { terminal_id, data } => {
                    let _ = output.send((terminal_id, data)).await;
                }
                _ => {}
            }
        }
    });
    let id = Uuid::new_v4();
    client
        .connect(
            id,
            profile(server.port),
            Credentials::password("portiva-test".into()),
        )
        .await?;
    let left = client.open_terminal(id, TerminalSize::default()).await?;
    let right = client.open_terminal(id, TerminalSize::default()).await?;
    assert_ne!(left.id, right.id);
    left.activate()?;
    right.activate()?;
    left.write(b"left-only\r\n".to_vec())?;
    right.write(b"right-only\r\n".to_vec())?;
    left.resize(TerminalSize {
        columns: 91,
        rows: 27,
    })?;
    right.resize(TerminalSize {
        columns: 47,
        rows: 12,
    })?;
    let before = client.remote_resources(id).await?;
    let after = client.remote_resources(id).await?;
    assert_eq!(after.cpu.usage_since(before.cpu), Some(25.));
    assert_eq!(after.memory.unwrap().percent(), 37.5);
    assert_eq!(after.disk.unwrap().percent(), 25.);
    let mut by_terminal: std::collections::HashMap<TerminalId, Vec<u8>> = Default::default();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (terminal_id, bytes) = received.recv().await.unwrap();
            by_terminal.entry(terminal_id).or_default().extend(bytes);
            if by_terminal
                .get(&left.id)
                .is_some_and(|bytes| bytes.ends_with(b"left-only\r\n"))
                && by_terminal
                    .get(&right.id)
                    .is_some_and(|bytes| bytes.ends_with(b"right-only\r\n"))
            {
                break;
            }
        }
    })
    .await?;
    assert!(!String::from_utf8_lossy(&by_terminal[&left.id]).contains("right-only"));
    assert!(!String::from_utf8_lossy(&by_terminal[&right.id]).contains("left-only"));
    assert!(
        by_terminal
            .values()
            .all(|data| !String::from_utf8_lossy(data).contains("PORTIVA_RESOURCES"))
    );
    left.close();
    right.write(b"still-alive".to_vec())?;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let ready = {
                let shells = server.shells.lock().unwrap();
                shells[0].closed
                    && shells[1].input.ends_with(b"still-alive")
                    && shells[0].size == (91, 27)
                    && shells[1].size == (47, 12)
            };
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert!(!client.list_remote(id, "/").await?.entries.is_empty());
    client.disconnect(id).await?;
    assert!(client.remote_resources(id).await.is_err());
    pump.abort();
    Ok(())
}
