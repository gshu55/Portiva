//! Real SSH X11 channels backed by a disposable loopback X server.
mod support;

use anyhow::{Context as _, Result};
use portiva_core::*;
use std::sync::{Arc, Mutex, atomic::Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

struct Display {
    address: String,
    cookies: Arc<Mutex<Vec<Vec<u8>>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Display {
    async fn start(accept_auth: bool) -> Result<Self> {
        // Windows can allocate ephemeral ports below the X11 base port.
        let mut listener = None;
        for port in 30000..30128 {
            if let Ok(bound) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                listener = Some(bound);
                break;
            }
        }
        let listener = listener.context("no available test display port")?;
        let number = listener
            .local_addr()?
            .port()
            .checked_sub(6000)
            .context("test port below 6000")?;
        let cookies = Arc::new(Mutex::new(Vec::new()));
        let observed = cookies.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let observed = observed.clone();
                tokio::spawn(async move {
                    let mut header = [0; 12];
                    socket.read_exact(&mut header).await.unwrap();
                    assert_eq!(header[0], b'l');
                    let protocol = usize::from(u16::from_le_bytes([header[6], header[7]]));
                    let cookie = usize::from(u16::from_le_bytes([header[8], header[9]]));
                    let padded_protocol = (protocol + 3) & !3;
                    let mut auth = vec![0; padded_protocol + ((cookie + 3) & !3)];
                    socket.read_exact(&mut auth).await.unwrap();
                    observed
                        .lock()
                        .unwrap()
                        .push(auth[padded_protocol..padded_protocol + cookie].to_vec());
                    socket
                        .write_all(&[u8::from(accept_auth), 0, 11, 0, 0, 0, 0, 0])
                        .await
                        .unwrap();
                    if accept_auth {
                        let mut buffer = [0; 1024];
                        while let Ok(length) = socket.read(&mut buffer).await {
                            if length == 0 || socket.write_all(&buffer[..length]).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        });
        Ok(Self {
            address: format!("127.0.0.1:{number}.3"),
            cookies,
            task,
        })
    }
}

impl Drop for Display {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn profile(port: u16, display: &Display) -> Profile {
    Profile {
        host: "127.0.0.1".into(),
        port,
        username: "demo".into(),
        x11: X11Settings {
            enabled: true,
            display: display.address.clone(),
        },
        ..Default::default()
    }
}

fn decode_cookie(cookie: &str) -> Vec<u8> {
    assert_eq!(cookie.len(), 32);
    (0..16)
        .map(|i| u8::from_str_radix(&cookie[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

async fn open_x11(
    request: &support::X11Request,
    cookie: &str,
) -> Result<impl AsyncRead + AsyncWrite + Unpin> {
    let channel = request.handle.channel_open_x11("127.0.0.1", 12345).await?;
    let mut stream = channel.into_stream();
    let mut setup = vec![b'l', 0, 11, 0, 0, 0, 18, 0, 16, 0, 0, 0];
    setup.extend_from_slice(b"MIT-MAGIC-COOKIE-1\0\0");
    setup.extend_from_slice(&decode_cookie(cookie));
    // Fragment the authentication packet and coalesce the first application request.
    stream.write_all(&setup[..5]).await?;
    setup.extend_from_slice(b"x11-data");
    stream.write_all(&setup[5..]).await?;
    Ok(stream)
}

async fn accepted(stream: &mut (impl AsyncRead + AsyncWrite + Unpin)) -> Result<()> {
    let mut reply = [0; 8];
    stream.read_exact(&mut reply).await?;
    assert_eq!(reply[0], 1);
    stream.read_exact(&mut reply).await?;
    assert_eq!(&reply, b"x11-data");
    Ok(())
}

async fn echo(stream: &mut (impl AsyncRead + AsyncWrite + Unpin)) -> Result<()> {
    stream.write_all(b"still-open").await?;
    let mut reply = [0; 10];
    stream.read_exact(&mut reply).await?;
    assert_eq!(&reply, b"still-open");
    Ok(())
}

async fn closed(stream: &mut (impl AsyncRead + Unpin)) -> Result<()> {
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), stream.read(&mut [0; 1])).await??,
        0
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ssh_x11_isolates_splits_connections_and_revokes_streams() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = support::TestServer::start(Duration::ZERO).await?;
        let display = Display::start(true).await?;
        let data = tempfile::tempdir()?;
        let store = Store::open(data.path())?;
        let profile = profile(server.port, &display);
        store.save_profile(profile.clone())?;
        assert_eq!(Store::open(data.path())?.profiles()?[0].x11, profile.x11);
        let (client, events) = Client::new(store);
        let (send_closed, terminal_closed) = async_channel::unbounded();
        let pump = tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                match event {
                    CoreEvent::HostKey(host) => {
                        let _ = host.response.send(true);
                    }
                    CoreEvent::TerminalClosed { terminal_id, .. } => {
                        let _ = send_closed.send(terminal_id).await;
                    }
                    _ => {}
                }
            }
        });
        let first_id = Uuid::new_v4();
        client
            .connect(
                first_id,
                profile.clone(),
                Credentials::password("portiva-test".into()),
            )
            .await?;
        let left = client
            .open_terminal(first_id, TerminalSize::default())
            .await?;
        let right = client
            .open_terminal(first_id, TerminalSize::default())
            .await?;
        let left_request = server.x11_requests.lock().unwrap()[0].clone();
        let right_request = server.x11_requests.lock().unwrap()[1].clone();
        assert_eq!(left_request.protocol, "MIT-MAGIC-COOKIE-1");
        assert_eq!(left_request.screen, 3);
        assert!(!left_request.single_connection);
        assert_ne!(left_request.cookie, right_request.cookie);
        let mut left_stream = open_x11(&left_request, &left_request.cookie).await?;
        let mut right_stream = open_x11(&right_request, &right_request.cookie).await?;
        accepted(&mut left_stream).await?;
        accepted(&mut right_stream).await?;
        for cookie in display.cookies.lock().unwrap().iter() {
            assert_ne!(cookie, &decode_cookie(&left_request.cookie));
            assert_ne!(cookie, &decode_cookie(&right_request.cookie));
        }

        let second_id = Uuid::new_v4();
        client
            .connect(
                second_id,
                profile,
                Credentials::password("portiva-test".into()),
            )
            .await?;
        let other = client
            .open_terminal(second_id, TerminalSize::default())
            .await?;
        let other_request = server.x11_requests.lock().unwrap()[2].clone();
        let mut other_stream = open_x11(&other_request, &other_request.cookie).await?;
        accepted(&mut other_stream).await?;
        let count = display.cookies.lock().unwrap().len();
        let mut forged = open_x11(&other_request, &left_request.cookie).await?;
        closed(&mut forged).await?;
        assert_eq!(
            display.cookies.lock().unwrap().len(),
            count,
            "foreign cookie reached local display"
        );

        left.close();
        assert_eq!(terminal_closed.recv().await?, left.id);
        closed(&mut left_stream).await?;
        let mut replay = open_x11(&left_request, &left_request.cookie).await?;
        closed(&mut replay).await?;
        assert_eq!(
            display.cookies.lock().unwrap().len(),
            count,
            "revoked cookie reached local display"
        );
        echo(&mut right_stream).await?;
        echo(&mut other_stream).await?;

        server.reject_x11.store(true, Ordering::SeqCst);
        let error = client
            .open_terminal(first_id, TerminalSize::default())
            .await
            .err()
            .context("X11 rejection was ignored")?;
        assert!(error.to_string().contains("服务器拒绝 X11"));
        assert!(
            client
                .list_remote(first_id, ".")
                .await?
                .entries
                .iter()
                .any(|entry| entry.name == "readme.txt")
        );
        echo(&mut right_stream).await?;
        client.disconnect(first_id).await?;
        closed(&mut right_stream).await?;
        echo(&mut other_stream).await?;
        other.close();
        right.close();
        client.disconnect(second_id).await?;
        closed(&mut other_stream).await?;
        pump.abort();
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_display_authentication_failure_preserves_ssh_and_sftp() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let server = support::TestServer::start(Duration::ZERO).await?;
        let display = Display::start(false).await?;
        let data = tempfile::tempdir()?;
        let (client, events) = Client::new(Store::open(data.path())?);
        let pump = tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                if let CoreEvent::HostKey(host) = event {
                    let _ = host.response.send(true);
                }
            }
        });
        let id = Uuid::new_v4();
        client
            .connect(
                id,
                profile(server.port, &display),
                Credentials::password("portiva-test".into()),
            )
            .await?;
        let error = client
            .open_terminal(id, TerminalSize::default())
            .await
            .err()
            .context("local authentication failure was ignored")?;
        assert!(error.to_string().contains("本机 X Server 拒绝认证"));
        assert!(server.x11_requests.lock().unwrap().is_empty());
        assert!(server.shells.lock().unwrap().is_empty());
        assert!(!client.list_remote(id, ".").await?.entries.is_empty());
        client.disconnect(id).await?;
        pump.abort();
        Ok::<_, anyhow::Error>(())
    })
    .await?
}
