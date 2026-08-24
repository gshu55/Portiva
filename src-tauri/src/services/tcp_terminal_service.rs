use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use encoding_rs::{
    CoderResult, Decoder as TextDecoder, Encoding, BIG5, EUC_KR, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::profile::{ConnectionProfile, ConnectionType};
use crate::domain::settings::NetworkProxySettings;
use crate::domain::terminal::{TerminalRenderPolicy, TerminalSessionStatus, TerminalSize};
use crate::services::network_proxy_service::connect_tcp;
use crate::services::terminal_service::{
    drain_utf8_terminal_output, terminal_disconnect_notice, TerminalService,
};

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TCP_READ_TIMEOUT: Duration = Duration::from_millis(100);
const TCP_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const TERMINAL_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const TERMINAL_OUTPUT_MAX_CHUNK_BYTES: usize = 32 * 1024;
const TERMINAL_SNAPSHOT_EVENT: &str = "portiva://terminal-snapshot";

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const TELNET_BINARY: u8 = 0;
const TELNET_ECHO: u8 = 1;
const TELNET_SUPPRESS_GO_AHEAD: u8 = 3;
const TELNET_TERMINAL_TYPE: u8 = 24;
const TELNET_NAWS: u8 = 31;
const TERMINAL_TYPE_IS: u8 = 0;
const TERMINAL_TYPE_SEND: u8 = 1;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    terminal_id: String,
    status: TerminalSessionStatus,
    buffered_bytes: usize,
    buffer_preview: String,
    history_truncated: bool,
    render_policy: TerminalRenderPolicy,
    output_chunk: String,
}

#[derive(Default)]
pub struct TcpTerminalService {
    profiles: Mutex<HashMap<String, ConnectionProfile>>,
    sessions: Mutex<HashMap<String, TcpRuntimeSession>>,
}

struct TcpRuntimeSession {
    connection_id: String,
    endpoint: String,
    writer: Arc<Mutex<TcpStream>>,
    mode: TcpTerminalMode,
    line_ending: TcpLineEnding,
    encoding: TcpTextEncoding,
    closed: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TcpTerminalMode {
    Telnet,
    RawTcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TcpLineEnding {
    CrLf,
    Cr,
    Lf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TcpTextEncoding {
    Ascii,
    Utf8,
    Gbk,
    Big5,
    ShiftJis,
    EucKr,
    Utf16Le,
    Utf16Be,
    Latin1,
}

impl TcpTerminalService {
    pub async fn test_profile(
        &self,
        profile: &ConnectionProfile,
        proxy: &NetworkProxySettings,
        proxy_password: Option<&str>,
    ) -> Result<(), String> {
        let (host, port) = tcp_endpoint(profile)?;
        let stream = connect_tcp_stream(&host, port, proxy, proxy_password).await?;
        let _ = stream.shutdown(Shutdown::Both);
        Ok(())
    }

    pub fn register_profile(
        &self,
        connection_id: &str,
        profile: ConnectionProfile,
    ) -> Result<(), String> {
        let _ = tcp_endpoint(&profile)?;
        tcp_line_ending(profile.line_ending.as_deref())?;
        tcp_text_encoding(profile.encoding.as_deref())?;

        self.profiles
            .lock()
            .map_err(|_| "tcp profile lock poisoned".to_string())?
            .insert(connection_id.to_string(), profile);
        Ok(())
    }

    pub async fn open_terminal(
        &self,
        connection_id: &str,
        terminal_id: &str,
        size: &TerminalSize,
        app_handle: AppHandle,
        proxy: &NetworkProxySettings,
        proxy_password: Option<&str>,
    ) -> Result<(), String> {
        if self.has_terminal(connection_id, terminal_id)? {
            return Ok(());
        }

        let profile = self
            .profiles
            .lock()
            .map_err(|_| "tcp profile lock poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| format!("tcp profile not found for connection: {connection_id}"))?;
        let mode = tcp_terminal_mode(&profile)?;
        let (host, port) = tcp_endpoint(&profile)?;
        let stream = connect_tcp_stream(&host, port, proxy, proxy_password).await?;
        stream
            .set_read_timeout(Some(TCP_READ_TIMEOUT))
            .map_err(|error| format!("failed to configure TCP read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(TCP_WRITE_TIMEOUT))
            .map_err(|error| format!("failed to configure TCP write timeout: {error}"))?;
        let _ = stream.set_nodelay(true);

        let reader = stream
            .try_clone()
            .map_err(|error| format!("failed to clone TCP stream reader: {error}"))?;
        let writer = Arc::new(Mutex::new(stream));
        let encoding = tcp_text_encoding(profile.encoding.as_deref())?;
        let line_ending = tcp_line_ending(profile.line_ending.as_deref())?;
        let terminal_type = profile
            .terminal_type
            .as_deref()
            .unwrap_or("xterm")
            .to_string();
        let closed = Arc::new(AtomicBool::new(false));
        let endpoint = format!("{host}:{port}");

        if matches!(mode, TcpTerminalMode::Telnet) {
            send_telnet_initial_negotiation(&writer, &terminal_type, size);
        }

        spawn_tcp_reader(
            app_handle,
            terminal_id.to_string(),
            endpoint.clone(),
            reader,
            Arc::clone(&writer),
            encoding,
            mode,
            terminal_type,
            Arc::clone(&closed),
        );

        self.sessions
            .lock()
            .map_err(|_| "tcp terminal service lock poisoned".to_string())?
            .insert(
                terminal_id.to_string(),
                TcpRuntimeSession {
                    connection_id: connection_id.to_string(),
                    endpoint,
                    writer,
                    mode,
                    line_ending,
                    encoding,
                    closed,
                },
            );

        Ok(())
    }

    pub fn write_terminal(
        &self,
        connection_id: &str,
        terminal_id: &str,
        data: &str,
    ) -> Result<(), String> {
        let (writer, mode, line_ending, encoding, endpoint) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "tcp terminal service lock poisoned".to_string())?;
            let session = sessions
                .get(terminal_id)
                .filter(|session| session.connection_id == connection_id)
                .ok_or_else(|| format!("tcp terminal not found: {terminal_id}"))?;

            (
                Arc::clone(&session.writer),
                session.mode,
                session.line_ending,
                session.encoding,
                session.endpoint.clone(),
            )
        };

        let mut bytes = encode_terminal_input(data, line_ending, encoding)?;
        if matches!(mode, TcpTerminalMode::Telnet) {
            bytes = escape_telnet_iac(&bytes);
        }

        let mut writer = writer
            .lock()
            .map_err(|_| "tcp writer lock poisoned".to_string())?;
        writer
            .write_all(&bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write TCP data to {endpoint}: {error}"))
    }

    pub fn write_terminal_bytes(
        &self,
        connection_id: &str,
        terminal_id: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let (writer, mode, endpoint) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "tcp terminal service lock poisoned".to_string())?;
            let session = sessions
                .get(terminal_id)
                .filter(|session| session.connection_id == connection_id)
                .ok_or_else(|| format!("tcp terminal not found: {terminal_id}"))?;

            (
                Arc::clone(&session.writer),
                session.mode,
                session.endpoint.clone(),
            )
        };

        if !matches!(mode, TcpTerminalMode::RawTcp) {
            return Err("raw byte writes are only supported for Raw TCP terminals".to_string());
        }

        let mut writer = writer
            .lock()
            .map_err(|_| "tcp writer lock poisoned".to_string())?;
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write raw TCP data to {endpoint}: {error}"))
    }

    pub fn resize_terminal(
        &self,
        connection_id: &str,
        terminal_id: &str,
        size: &TerminalSize,
    ) -> Result<(), String> {
        let (writer, mode) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "tcp terminal service lock poisoned".to_string())?;
            let session = sessions
                .get(terminal_id)
                .filter(|session| session.connection_id == connection_id)
                .ok_or_else(|| format!("tcp terminal not found: {terminal_id}"))?;

            (Arc::clone(&session.writer), session.mode)
        };

        if matches!(mode, TcpTerminalMode::Telnet) {
            send_telnet_naws(&writer, size);
        }

        Ok(())
    }

    pub fn close_terminal(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "tcp terminal service lock poisoned".to_string())?
            .remove(terminal_id);

        let Some(session) = session else {
            return Ok(false);
        };

        if session.connection_id != connection_id {
            self.sessions
                .lock()
                .map_err(|_| "tcp terminal service lock poisoned".to_string())?
                .insert(terminal_id.to_string(), session);
            return Ok(false);
        }

        session.closed.store(true, Ordering::Relaxed);
        if let Ok(writer) = session.writer.lock() {
            let _ = writer.shutdown(Shutdown::Both);
        }
        Ok(true)
    }

    pub fn close_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "tcp terminal service lock poisoned".to_string())?;
        let terminal_ids = sessions
            .iter()
            .filter(|(_, session)| session.connection_id == connection_id)
            .map(|(terminal_id, _)| terminal_id.clone())
            .collect::<Vec<_>>();

        for terminal_id in &terminal_ids {
            if let Some(session) = sessions.remove(terminal_id) {
                session.closed.store(true, Ordering::Relaxed);
                if let Ok(writer) = session.writer.lock() {
                    let _ = writer.shutdown(Shutdown::Both);
                }
            }
        }
        drop(sessions);

        self.profiles
            .lock()
            .map_err(|_| "tcp profile lock poisoned".to_string())?
            .remove(connection_id);

        Ok(terminal_ids.len())
    }

    pub fn has_terminal(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "tcp terminal service lock poisoned".to_string())?
            .get(terminal_id)
            .map(|session| session.connection_id == connection_id)
            .unwrap_or(false))
    }

    fn close_terminal_by_id(&self, terminal_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "tcp terminal service lock poisoned".to_string())?
            .remove(terminal_id);

        let Some(session) = session else {
            return Ok(false);
        };

        session.closed.store(true, Ordering::Relaxed);
        if let Ok(writer) = session.writer.lock() {
            let _ = writer.shutdown(Shutdown::Both);
        }
        Ok(true)
    }
}

fn tcp_terminal_mode(profile: &ConnectionProfile) -> Result<TcpTerminalMode, String> {
    match profile.r#type {
        ConnectionType::Telnet => Ok(TcpTerminalMode::Telnet),
        ConnectionType::RawTcp => Ok(TcpTerminalMode::RawTcp),
        _ => Err("profile is not a TCP terminal protocol".to_string()),
    }
}

fn tcp_endpoint(profile: &ConnectionProfile) -> Result<(String, u16), String> {
    let host = profile
        .host
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if host.is_empty() {
        return Err("host is required".to_string());
    }

    let Some(port @ 1..=65535) = profile.port else {
        return Err("port must be between 1 and 65535".to_string());
    };

    Ok((host, port))
}

async fn connect_tcp_stream(
    host: &str,
    port: u16,
    proxy: &NetworkProxySettings,
    proxy_password: Option<&str>,
) -> Result<TcpStream, String> {
    let stream = connect_tcp(proxy, proxy_password, host, port, TCP_CONNECT_TIMEOUT).await?;
    let stream = stream
        .into_std()
        .map_err(|error| format!("无法转换 TCP 连接：{error}"))?;
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("无法配置 TCP 连接：{error}"))?;
    Ok(stream)
}

fn tcp_line_ending(input: Option<&str>) -> Result<TcpLineEnding, String> {
    match input.unwrap_or("crlf") {
        "crlf" => Ok(TcpLineEnding::CrLf),
        "cr" => Ok(TcpLineEnding::Cr),
        "lf" => Ok(TcpLineEnding::Lf),
        unexpected => Err(format!("unsupported TCP line ending: {unexpected}")),
    }
}

fn tcp_text_encoding(input: Option<&str>) -> Result<TcpTextEncoding, String> {
    match input.unwrap_or("utf-8") {
        "ascii" => Ok(TcpTextEncoding::Ascii),
        "utf-8" => Ok(TcpTextEncoding::Utf8),
        "gbk" => Ok(TcpTextEncoding::Gbk),
        "big5" => Ok(TcpTextEncoding::Big5),
        "shift-jis" => Ok(TcpTextEncoding::ShiftJis),
        "euc-kr" => Ok(TcpTextEncoding::EucKr),
        "utf-16le" => Ok(TcpTextEncoding::Utf16Le),
        "utf-16be" => Ok(TcpTextEncoding::Utf16Be),
        "latin1" => Ok(TcpTextEncoding::Latin1),
        unexpected => Err(format!("unsupported TCP encoding: {unexpected}")),
    }
}

fn tcp_encoding_label(encoding: TcpTextEncoding) -> &'static str {
    match encoding {
        TcpTextEncoding::Ascii => "ASCII",
        TcpTextEncoding::Utf8 => "UTF-8",
        TcpTextEncoding::Gbk => "GBK",
        TcpTextEncoding::Big5 => "Big5",
        TcpTextEncoding::ShiftJis => "Shift_JIS",
        TcpTextEncoding::EucKr => "EUC-KR",
        TcpTextEncoding::Utf16Le => "UTF-16LE",
        TcpTextEncoding::Utf16Be => "UTF-16BE",
        TcpTextEncoding::Latin1 => "Latin-1",
    }
}

fn encode_terminal_input(
    input: &str,
    line_ending: TcpLineEnding,
    encoding: TcpTextEncoding,
) -> Result<Vec<u8>, String> {
    let normalized = match line_ending {
        TcpLineEnding::CrLf => normalize_line_endings(input, "\r\n"),
        TcpLineEnding::Cr => normalize_line_endings(input, "\r"),
        TcpLineEnding::Lf => normalize_line_endings(input, "\n"),
    };

    match encoding {
        TcpTextEncoding::Ascii => normalized
            .chars()
            .map(|ch| {
                if (ch as u32) <= 0x7f {
                    Ok(ch as u8)
                } else {
                    Err(format!(
                        "character U+{:04X} cannot be encoded as ASCII",
                        ch as u32
                    ))
                }
            })
            .collect(),
        TcpTextEncoding::Utf8 => Ok(normalized.into_bytes()),
        TcpTextEncoding::Latin1 => normalized
            .chars()
            .map(|ch| {
                if (ch as u32) <= 0xff {
                    Ok(ch as u8)
                } else {
                    Err(format!(
                        "character U+{:04X} cannot be encoded as latin1",
                        ch as u32
                    ))
                }
            })
            .collect(),
        TcpTextEncoding::Gbk
        | TcpTextEncoding::Big5
        | TcpTextEncoding::ShiftJis
        | TcpTextEncoding::EucKr
        | TcpTextEncoding::Utf16Le
        | TcpTextEncoding::Utf16Be => {
            let encoding_impl = match encoding {
                TcpTextEncoding::Gbk => GBK,
                TcpTextEncoding::Big5 => BIG5,
                TcpTextEncoding::ShiftJis => SHIFT_JIS,
                TcpTextEncoding::EucKr => EUC_KR,
                TcpTextEncoding::Utf16Le => UTF_16LE,
                TcpTextEncoding::Utf16Be => UTF_16BE,
                _ => unreachable!("handled above"),
            };
            let (encoded, _, had_errors) = encoding_impl.encode(&normalized);
            if had_errors {
                return Err(format!(
                    "input contains characters that cannot be encoded as {}",
                    tcp_encoding_label(encoding)
                ));
            }
            Ok(encoded.into_owned())
        }
    }
}

fn normalize_line_endings(input: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if matches!(chars.peek(), Some('\n')) {
                    let _ = chars.next();
                }
                output.push_str(replacement);
            }
            '\n' => output.push_str(replacement),
            _ => output.push(ch),
        }
    }

    output
}

fn decode_output_bytes(
    pending_bytes: &mut Vec<u8>,
    encoding: TcpTextEncoding,
    decoder: Option<&mut TextDecoder>,
    force: bool,
) -> String {
    if pending_bytes.is_empty() {
        if let Some(decoder) = decoder {
            if force {
                return decode_streaming_output(decoder, &[], true);
            }
        }
        return String::new();
    }

    if matches!(encoding, TcpTextEncoding::Utf8) {
        return drain_utf8_terminal_output(pending_bytes, force);
    }

    let bytes = std::mem::take(pending_bytes);
    match encoding {
        TcpTextEncoding::Ascii => bytes
            .into_iter()
            .map(|byte| {
                if byte <= 0x7f {
                    char::from(byte)
                } else {
                    '\u{FFFD}'
                }
            })
            .collect(),
        TcpTextEncoding::Latin1 => bytes.iter().map(|byte| char::from(*byte)).collect(),
        TcpTextEncoding::Utf8 => unreachable!("handled above"),
        TcpTextEncoding::Gbk
        | TcpTextEncoding::Big5
        | TcpTextEncoding::ShiftJis
        | TcpTextEncoding::EucKr
        | TcpTextEncoding::Utf16Le
        | TcpTextEncoding::Utf16Be => {
            let decoder = decoder.expect("streaming decoder is required for multibyte encodings");
            decode_streaming_output(decoder, &bytes, force)
        }
    }
}

fn streaming_tcp_encoding(encoding: TcpTextEncoding) -> Option<&'static Encoding> {
    match encoding {
        TcpTextEncoding::Gbk => Some(GBK),
        TcpTextEncoding::Big5 => Some(BIG5),
        TcpTextEncoding::ShiftJis => Some(SHIFT_JIS),
        TcpTextEncoding::EucKr => Some(EUC_KR),
        TcpTextEncoding::Utf16Le => Some(UTF_16LE),
        TcpTextEncoding::Utf16Be => Some(UTF_16BE),
        TcpTextEncoding::Ascii | TcpTextEncoding::Utf8 | TcpTextEncoding::Latin1 => None,
    }
}

fn decode_streaming_output(decoder: &mut TextDecoder, bytes: &[u8], force: bool) -> String {
    let mut output = String::new();
    let mut remaining = bytes;

    loop {
        let additional_capacity = decoder
            .max_utf8_buffer_length(remaining.len())
            .unwrap_or_else(|| remaining.len().saturating_mul(4).saturating_add(8))
            .max(8);
        output.reserve(additional_capacity);

        let (result, read, _) = decoder.decode_to_string(remaining, &mut output, force);
        remaining = &remaining[read..];

        match result {
            CoderResult::InputEmpty => break,
            CoderResult::OutputFull => continue,
        }
    }

    output
}

fn escape_telnet_iac(bytes: &[u8]) -> Vec<u8> {
    let mut escaped = Vec::with_capacity(bytes.len());
    for byte in bytes {
        escaped.push(*byte);
        if *byte == IAC {
            escaped.push(IAC);
        }
    }
    escaped
}

fn send_telnet_initial_negotiation(
    writer: &Arc<Mutex<TcpStream>>,
    terminal_type: &str,
    size: &TerminalSize,
) {
    write_telnet_command(writer, &[IAC, WILL, TELNET_TERMINAL_TYPE]);
    write_telnet_command(writer, &[IAC, WILL, TELNET_NAWS]);
    write_telnet_command(writer, &[IAC, WILL, TELNET_SUPPRESS_GO_AHEAD]);
    write_telnet_command(writer, &[IAC, DO, TELNET_SUPPRESS_GO_AHEAD]);
    send_telnet_terminal_type(writer, terminal_type);
    send_telnet_naws(writer, size);
}

fn send_telnet_terminal_type(writer: &Arc<Mutex<TcpStream>>, terminal_type: &str) {
    let mut payload = vec![IAC, SB, TELNET_TERMINAL_TYPE, TERMINAL_TYPE_IS];
    payload.extend(
        terminal_type
            .as_bytes()
            .iter()
            .map(|byte| byte.to_ascii_uppercase()),
    );
    payload.extend([IAC, SE]);
    write_telnet_command(writer, &payload);
}

fn send_telnet_naws(writer: &Arc<Mutex<TcpStream>>, size: &TerminalSize) {
    let cols = size.cols.max(1);
    let rows = size.rows.max(1);
    let mut payload = vec![IAC, SB, TELNET_NAWS];
    push_telnet_escaped_byte(&mut payload, (cols >> 8) as u8);
    push_telnet_escaped_byte(&mut payload, cols as u8);
    push_telnet_escaped_byte(&mut payload, (rows >> 8) as u8);
    push_telnet_escaped_byte(&mut payload, rows as u8);
    payload.extend([IAC, SE]);
    write_telnet_command(writer, &payload);
}

fn push_telnet_escaped_byte(payload: &mut Vec<u8>, byte: u8) {
    payload.push(byte);
    if byte == IAC {
        payload.push(IAC);
    }
}

fn write_telnet_command(writer: &Arc<Mutex<TcpStream>>, bytes: &[u8]) {
    if let Ok(mut writer) = writer.lock() {
        let _ = writer.write_all(bytes);
        let _ = writer.flush();
    }
}

#[derive(Debug)]
enum TelnetParseState {
    Data,
    Iac,
    Negotiation(u8),
    Subnegotiation {
        option: Option<u8>,
        data: Vec<u8>,
        iac: bool,
    },
}

struct TelnetCodec {
    state: TelnetParseState,
    terminal_type: String,
}

impl TelnetCodec {
    fn new(terminal_type: String) -> Self {
        Self {
            state: TelnetParseState::Data,
            terminal_type,
        }
    }

    fn process(&mut self, input: &[u8], writer: &Arc<Mutex<TcpStream>>) -> Vec<u8> {
        let mut output = Vec::with_capacity(input.len());

        for byte in input {
            let state = std::mem::replace(&mut self.state, TelnetParseState::Data);
            self.state = match state {
                TelnetParseState::Data => {
                    if *byte == IAC {
                        TelnetParseState::Iac
                    } else {
                        output.push(*byte);
                        TelnetParseState::Data
                    }
                }
                TelnetParseState::Iac => match *byte {
                    IAC => {
                        output.push(IAC);
                        TelnetParseState::Data
                    }
                    DO | DONT | WILL | WONT => TelnetParseState::Negotiation(*byte),
                    SB => TelnetParseState::Subnegotiation {
                        option: None,
                        data: Vec::new(),
                        iac: false,
                    },
                    _ => TelnetParseState::Data,
                },
                TelnetParseState::Negotiation(command) => {
                    respond_telnet_negotiation(writer, command, *byte);
                    TelnetParseState::Data
                }
                TelnetParseState::Subnegotiation {
                    mut option,
                    mut data,
                    iac,
                } => {
                    if option.is_none() {
                        option = Some(*byte);
                        TelnetParseState::Subnegotiation { option, data, iac }
                    } else if iac {
                        if *byte == SE {
                            respond_telnet_subnegotiation(
                                writer,
                                option,
                                &data,
                                &self.terminal_type,
                            );
                            TelnetParseState::Data
                        } else if *byte == IAC {
                            data.push(IAC);
                            TelnetParseState::Subnegotiation {
                                option,
                                data,
                                iac: false,
                            }
                        } else {
                            TelnetParseState::Subnegotiation {
                                option,
                                data,
                                iac: false,
                            }
                        }
                    } else if *byte == IAC {
                        TelnetParseState::Subnegotiation {
                            option,
                            data,
                            iac: true,
                        }
                    } else {
                        data.push(*byte);
                        TelnetParseState::Subnegotiation { option, data, iac }
                    }
                }
            };
        }

        output
    }
}

fn respond_telnet_subnegotiation(
    writer: &Arc<Mutex<TcpStream>>,
    option: Option<u8>,
    data: &[u8],
    terminal_type: &str,
) {
    if option == Some(TELNET_TERMINAL_TYPE) && data.first() == Some(&TERMINAL_TYPE_SEND) {
        send_telnet_terminal_type(writer, terminal_type);
    }
}

fn respond_telnet_negotiation(writer: &Arc<Mutex<TcpStream>>, command: u8, option: u8) {
    let response = match command {
        DO => match option {
            TELNET_TERMINAL_TYPE | TELNET_NAWS | TELNET_SUPPRESS_GO_AHEAD => [IAC, WILL, option],
            _ => [IAC, WONT, option],
        },
        DONT => [IAC, WONT, option],
        WILL => match option {
            TELNET_ECHO | TELNET_SUPPRESS_GO_AHEAD | TELNET_BINARY => [IAC, DO, option],
            _ => [IAC, DONT, option],
        },
        WONT => [IAC, DONT, option],
        _ => return,
    };

    write_telnet_command(writer, &response);
}

#[allow(clippy::too_many_arguments)]
fn spawn_tcp_reader(
    app_handle: AppHandle,
    terminal_id: String,
    endpoint: String,
    mut reader: TcpStream,
    writer: Arc<Mutex<TcpStream>>,
    encoding: TcpTextEncoding,
    mode: TcpTerminalMode,
    terminal_type: String,
    closed: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending_bytes = Vec::new();
        let mut last_flush = Instant::now()
            .checked_sub(TERMINAL_OUTPUT_FLUSH_INTERVAL)
            .unwrap_or_else(Instant::now);
        let mut disconnect_reason = format!("TCP 连接已关闭：{endpoint}");
        let mut telnet_codec =
            matches!(mode, TcpTerminalMode::Telnet).then(|| TelnetCodec::new(terminal_type));
        let mut text_decoder = streaming_tcp_encoding(encoding).map(Encoding::new_decoder);

        loop {
            if closed.load(Ordering::Relaxed) {
                disconnect_reason = format!("TCP 连接已关闭：{endpoint}");
                break;
            }

            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(byte_count) => {
                    let bytes = &buffer[..byte_count];
                    if let Some(codec) = &mut telnet_codec {
                        pending_bytes.extend(codec.process(bytes, &writer));
                    } else {
                        pending_bytes.extend_from_slice(bytes);
                    }

                    if pending_bytes.len() >= TERMINAL_OUTPUT_MAX_CHUNK_BYTES
                        || last_flush.elapsed() >= TERMINAL_OUTPUT_FLUSH_INTERVAL
                    {
                        flush_terminal_output(
                            &app_handle,
                            &terminal_id,
                            &mut pending_bytes,
                            encoding,
                            text_decoder.as_mut(),
                            &mut last_flush,
                            false,
                        );
                    }
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    flush_terminal_output(
                        &app_handle,
                        &terminal_id,
                        &mut pending_bytes,
                        encoding,
                        text_decoder.as_mut(),
                        &mut last_flush,
                        false,
                    );
                    continue;
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => {
                    flush_terminal_output(
                        &app_handle,
                        &terminal_id,
                        &mut pending_bytes,
                        encoding,
                        text_decoder.as_mut(),
                        &mut last_flush,
                        true,
                    );
                    disconnect_reason = format!("读取 TCP 输出失败：{endpoint}: {error}");
                    break;
                }
            }
        }

        flush_terminal_output(
            &app_handle,
            &terminal_id,
            &mut pending_bytes,
            encoding,
            text_decoder.as_mut(),
            &mut last_flush,
            true,
        );
        emit_terminal_disconnected(&app_handle, &terminal_id, &disconnect_reason);
        let tcp_terminals = app_handle.state::<TcpTerminalService>();
        let _ = tcp_terminals.close_terminal_by_id(&terminal_id);
    });
}

fn flush_terminal_output(
    app_handle: &AppHandle,
    terminal_id: &str,
    pending_bytes: &mut Vec<u8>,
    encoding: TcpTextEncoding,
    decoder: Option<&mut TextDecoder>,
    last_flush: &mut Instant,
    force: bool,
) {
    if pending_bytes.is_empty() && !(force && decoder.is_some()) {
        return;
    }

    let output = decode_output_bytes(pending_bytes, encoding, decoder, force);
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
                history_truncated: metadata.history_truncated,
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
                history_truncated: snapshot.history_truncated,
                render_policy: snapshot.render_policy,
                output_chunk: output,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_output_bytes, encode_terminal_input, escape_telnet_iac, streaming_tcp_encoding,
        tcp_line_ending, TcpLineEnding, TcpTextEncoding,
    };

    #[test]
    fn tcp_input_applies_crlf_line_ending() {
        assert_eq!(
            encode_terminal_input("help\n", TcpLineEnding::CrLf, TcpTextEncoding::Utf8).unwrap(),
            b"help\r\n"
        );
        assert_eq!(
            encode_terminal_input("help\r", TcpLineEnding::CrLf, TcpTextEncoding::Utf8).unwrap(),
            b"help\r\n"
        );
    }

    #[test]
    fn parses_default_tcp_line_ending() {
        assert_eq!(tcp_line_ending(None).unwrap(), TcpLineEnding::CrLf);
        assert_eq!(tcp_line_ending(Some("lf")).unwrap(), TcpLineEnding::Lf);
    }

    #[test]
    fn escapes_telnet_iac_input() {
        assert_eq!(
            escape_telnet_iac(&[b'a', 255, b'b']),
            vec![b'a', 255, 255, b'b']
        );
    }

    #[test]
    fn gbk_output_keeps_split_multibyte_character_until_complete() {
        let mut decoder = streaming_tcp_encoding(TcpTextEncoding::Gbk)
            .unwrap()
            .new_decoder();
        let mut pending = vec![0xD6];

        assert_eq!(
            decode_output_bytes(
                &mut pending,
                TcpTextEncoding::Gbk,
                Some(&mut decoder),
                false
            ),
            ""
        );

        pending.push(0xD0);
        assert_eq!(
            decode_output_bytes(
                &mut pending,
                TcpTextEncoding::Gbk,
                Some(&mut decoder),
                false
            ),
            "中"
        );
    }
}
