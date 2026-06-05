use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use encoding_rs::{BIG5, EUC_KR, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE};
use serial2::{CharSize, FlowControl, Parity, SerialPort, Settings, StopBits};
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::profile::ConnectionProfile;
use crate::domain::serial::{SerialPortInfo, SerialPortType};
use crate::domain::terminal::{TerminalRenderPolicy, TerminalSessionStatus};
use crate::services::terminal_service::{terminal_disconnect_notice, TerminalService};

const SERIAL_READ_TIMEOUT: Duration = Duration::from_millis(100);
const SERIAL_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const SERIAL_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(32);
const SERIAL_OUTPUT_MAX_CHUNK_BYTES: usize = 16 * 1024;
const TERMINAL_SNAPSHOT_EVENT: &str = "portiva://terminal-snapshot";
const SERIAL_RX_EVENT: &str = "portiva://serial-rx";

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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialRxEvent {
    terminal_id: String,
    seq: u64,
    timestamp_us: u64,
    bytes: Vec<u8>,
    text: String,
}

#[derive(Default)]
pub struct SerialService {
    profiles: Mutex<HashMap<String, ConnectionProfile>>,
    sessions: Mutex<HashMap<String, SerialRuntimeSession>>,
}

struct SerialRuntimeSession {
    connection_id: String,
    port_name: String,
    port: Arc<Mutex<SerialPort>>,
    line_ending: SerialLineEnding,
    encoding: SerialEncoding,
    closed: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SerialLineEnding {
    CrLf,
    Cr,
    Lf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SerialEncoding {
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

impl SerialService {
    pub fn list_ports(&self) -> Result<Vec<SerialPortInfo>, String> {
        let active_ports = self.active_port_names()?;
        let mut ports = SerialPort::available_ports()
            .map_err(|error| format!("failed to list serial ports: {error}"))?
            .into_iter()
            .filter(include_serial_port_path)
            .map(|path| serial_port_info(path, &active_ports))
            .collect::<Vec<_>>();

        ports.sort_by(|left, right| left.port_name.cmp(&right.port_name));
        Ok(ports)
    }

    pub fn test_profile(&self, profile: &ConnectionProfile) -> Result<(), String> {
        let port_name = profile.port_name.as_deref().unwrap_or_default().trim();
        if port_name.is_empty() {
            return Err("serial port is required".to_string());
        }

        if self
            .active_port_names()?
            .iter()
            .any(|active_port| active_port == port_name)
        {
            return Err(format!(
                "serial port is already open in Portiva: {port_name}"
            ));
        }

        let _port = open_serial_port(profile)?;
        Ok(())
    }

    pub fn register_profile(
        &self,
        connection_id: &str,
        profile: ConnectionProfile,
    ) -> Result<(), String> {
        if profile
            .port_name
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("serial port is required".to_string());
        }

        self.profiles
            .lock()
            .map_err(|_| "serial profile lock poisoned".to_string())?
            .insert(connection_id.to_string(), profile);
        Ok(())
    }

    pub fn open_terminal(
        &self,
        connection_id: &str,
        terminal_id: &str,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        if self.has_terminal(connection_id, terminal_id)? {
            return Ok(());
        }

        let profile = self
            .profiles
            .lock()
            .map_err(|_| "serial profile lock poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| format!("serial profile not found for connection: {connection_id}"))?;
        let mut port = open_serial_port(&profile)?;
        let reader = port
            .try_clone()
            .map_err(|error| format!("failed to clone serial port reader: {error}"))?;
        port.set_read_timeout(SERIAL_READ_TIMEOUT)
            .map_err(|error| format!("failed to configure serial read timeout: {error}"))?;
        port.set_write_timeout(SERIAL_WRITE_TIMEOUT)
            .map_err(|error| format!("failed to configure serial write timeout: {error}"))?;

        let port_name = profile
            .port_name
            .clone()
            .ok_or_else(|| "serial port is required".to_string())?;
        let encoding = serial_encoding(profile.encoding.as_deref())?;
        let line_ending = serial_line_ending(profile.line_ending.as_deref())?;
        let closed = Arc::new(AtomicBool::new(false));
        spawn_serial_reader(
            app_handle,
            terminal_id.to_string(),
            port_name.clone(),
            reader,
            encoding,
            Arc::clone(&closed),
        );

        self.sessions
            .lock()
            .map_err(|_| "serial service lock poisoned".to_string())?
            .insert(
                terminal_id.to_string(),
                SerialRuntimeSession {
                    connection_id: connection_id.to_string(),
                    port_name,
                    port: Arc::new(Mutex::new(port)),
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
        let (port, line_ending, encoding, port_name) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "serial service lock poisoned".to_string())?;
            let session = sessions
                .get(terminal_id)
                .filter(|session| session.connection_id == connection_id)
                .ok_or_else(|| format!("serial terminal not found: {terminal_id}"))?;

            (
                Arc::clone(&session.port),
                session.line_ending,
                session.encoding,
                session.port_name.clone(),
            )
        };

        let bytes = encode_terminal_input(data, line_ending, encoding)?;
        let port = port
            .lock()
            .map_err(|_| "serial port writer lock poisoned".to_string())?;
        port.write_all(&bytes)
            .and_then(|_| port.flush())
            .map_err(|error| format!("failed to write serial data to {port_name}: {error}"))
    }

    pub fn write_terminal_bytes(
        &self,
        connection_id: &str,
        terminal_id: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let (port, port_name) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "serial service lock poisoned".to_string())?;
            let session = sessions
                .get(terminal_id)
                .filter(|session| session.connection_id == connection_id)
                .ok_or_else(|| format!("serial terminal not found: {terminal_id}"))?;

            (Arc::clone(&session.port), session.port_name.clone())
        };

        let port = port
            .lock()
            .map_err(|_| "serial port writer lock poisoned".to_string())?;
        port.write_all(bytes)
            .and_then(|_| port.flush())
            .map_err(|error| format!("failed to write serial data to {port_name}: {error}"))
    }

    pub fn close_terminal(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "serial service lock poisoned".to_string())?
            .remove(terminal_id);

        let Some(session) = session else {
            return Ok(false);
        };

        if session.connection_id != connection_id {
            self.sessions
                .lock()
                .map_err(|_| "serial service lock poisoned".to_string())?
                .insert(terminal_id.to_string(), session);
            return Ok(false);
        }

        session.closed.store(true, Ordering::Relaxed);
        Ok(true)
    }

    pub fn close_terminal_by_id(&self, terminal_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "serial service lock poisoned".to_string())?
            .remove(terminal_id);

        if let Some(session) = session {
            session.closed.store(true, Ordering::Relaxed);
            return Ok(true);
        }

        Ok(false)
    }

    pub fn close_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "serial service lock poisoned".to_string())?;
        let terminal_ids = sessions
            .iter()
            .filter_map(|(terminal_id, session)| {
                (session.connection_id == connection_id).then(|| terminal_id.clone())
            })
            .collect::<Vec<_>>();

        for terminal_id in &terminal_ids {
            if let Some(session) = sessions.remove(terminal_id) {
                session.closed.store(true, Ordering::Relaxed);
            }
        }
        drop(sessions);

        self.profiles
            .lock()
            .map_err(|_| "serial profile lock poisoned".to_string())?
            .remove(connection_id);

        Ok(terminal_ids.len())
    }

    pub fn has_terminal(&self, connection_id: &str, terminal_id: &str) -> Result<bool, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "serial service lock poisoned".to_string())?
            .get(terminal_id)
            .map(|session| session.connection_id == connection_id)
            .unwrap_or(false))
    }

    fn active_port_names(&self) -> Result<Vec<String>, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "serial service lock poisoned".to_string())?
            .values()
            .map(|session| session.port_name.clone())
            .collect())
    }
}

fn open_serial_port(profile: &ConnectionProfile) -> Result<SerialPort, String> {
    let port_name = profile
        .port_name
        .as_deref()
        .ok_or_else(|| "serial port is required".to_string())?
        .trim()
        .to_string();
    let baud_rate = profile.baud_rate.unwrap_or(115_200);
    let data_bits = profile.data_bits.unwrap_or(8);
    let parity = profile.parity.as_deref().unwrap_or("none").to_string();
    let stop_bits = profile.stop_bits.unwrap_or(1.0);
    let flow_control = profile
        .flow_control
        .as_deref()
        .unwrap_or("none")
        .to_string();

    let port = SerialPort::open(&port_name, move |mut settings: Settings| {
        settings.set_raw();
        settings.set_baud_rate(baud_rate)?;
        settings.set_char_size(to_char_size(data_bits)?);
        settings.set_stop_bits(to_stop_bits(stop_bits)?);
        settings.set_parity(to_parity(&parity)?);
        settings.set_flow_control(to_flow_control(&flow_control)?);
        Ok(settings)
    })
    .map_err(|error| format_serial_open_error(&port_name, error))?;

    if let Some(dtr) = profile.dtr {
        port.set_dtr(dtr)
            .map_err(|error| format!("failed to set DTR on {port_name}: {error}"))?;
    }
    if let Some(rts) = profile.rts {
        port.set_rts(rts)
            .map_err(|error| format!("failed to set RTS on {port_name}: {error}"))?;
    }
    let _ = port.discard_input_buffer();

    Ok(port)
}

fn serial_port_info(path: PathBuf, active_ports: &[String]) -> SerialPortInfo {
    let port_name = path.to_string_lossy().to_string();
    let normalized_port_name = normalize_serial_port_name(path);

    SerialPortInfo {
        display_name: serial_display_name(&port_name),
        is_available: !active_ports
            .iter()
            .any(|active_port| active_port == &normalized_port_name),
        port_name: normalized_port_name,
        port_type: SerialPortType::Unknown,
        manufacturer: None,
        vid: None,
        pid: None,
    }
}

fn normalize_serial_port_name(path: PathBuf) -> String {
    #[cfg(windows)]
    {
        path.to_string_lossy().to_string()
    }

    #[cfg(not(windows))]
    {
        path.to_string_lossy().to_string()
    }
}

#[cfg(target_os = "macos")]
fn include_serial_port_path(path: &PathBuf) -> bool {
    !path.to_string_lossy().starts_with("/dev/tty.")
}

#[cfg(not(target_os = "macos"))]
fn include_serial_port_path(_path: &PathBuf) -> bool {
    true
}

fn serial_display_name(port_name: &str) -> String {
    if cfg!(target_os = "macos") && port_name.starts_with("/dev/tty.") {
        format!("{port_name} (dial-in)")
    } else if cfg!(target_os = "macos") && port_name.starts_with("/dev/cu.") {
        format!("{port_name} (callout)")
    } else {
        port_name.to_string()
    }
}

fn format_serial_open_error(port_name: &str, error: std::io::Error) -> String {
    match error.kind() {
        ErrorKind::NotFound => format!("serial port not found: {port_name}"),
        ErrorKind::PermissionDenied => format!(
            "serial port permission denied: {port_name}. On Linux, add the user to the dialout/uucp serial group or adjust device permissions."
        ),
        ErrorKind::AlreadyExists | ErrorKind::AddrInUse | ErrorKind::ResourceBusy => {
            format!("serial port is busy: {port_name}")
        }
        _ => format!("failed to open serial port {port_name}: {error}"),
    }
}

fn to_char_size(data_bits: u8) -> std::io::Result<CharSize> {
    CharSize::try_from(data_bits).map_err(|_| {
        std::io::Error::new(
            ErrorKind::InvalidInput,
            format!("unsupported serial data bits: {data_bits}"),
        )
    })
}

fn to_stop_bits(stop_bits: f32) -> std::io::Result<StopBits> {
    if (stop_bits - 1.0).abs() < f32::EPSILON {
        return Ok(StopBits::One);
    }
    if (stop_bits - 2.0).abs() < f32::EPSILON {
        return Ok(StopBits::Two);
    }

    Err(std::io::Error::new(
        ErrorKind::InvalidInput,
        "1.5 stop bits are not supported by the current serial backend",
    ))
}

fn to_parity(parity: &str) -> std::io::Result<Parity> {
    match parity {
        "none" => Ok(Parity::None),
        "odd" => Ok(Parity::Odd),
        "even" => Ok(Parity::Even),
        "mark" | "space" => Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "mark/space parity is not supported by the current serial backend",
        )),
        unexpected => Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            format!("unsupported serial parity: {unexpected}"),
        )),
    }
}

fn to_flow_control(flow_control: &str) -> std::io::Result<FlowControl> {
    match flow_control {
        "none" => Ok(FlowControl::None),
        "software" => Ok(FlowControl::XonXoff),
        "hardware" => Ok(FlowControl::RtsCts),
        unexpected => Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            format!("unsupported serial flow control: {unexpected}"),
        )),
    }
}

fn serial_line_ending(input: Option<&str>) -> Result<SerialLineEnding, String> {
    match input.unwrap_or("crlf") {
        "crlf" => Ok(SerialLineEnding::CrLf),
        "cr" => Ok(SerialLineEnding::Cr),
        "lf" => Ok(SerialLineEnding::Lf),
        unexpected => Err(format!("unsupported serial line ending: {unexpected}")),
    }
}

fn serial_encoding(input: Option<&str>) -> Result<SerialEncoding, String> {
    match input.unwrap_or("utf-8") {
        "ascii" => Ok(SerialEncoding::Ascii),
        "utf-8" => Ok(SerialEncoding::Utf8),
        "gbk" => Ok(SerialEncoding::Gbk),
        "big5" => Ok(SerialEncoding::Big5),
        "shift-jis" => Ok(SerialEncoding::ShiftJis),
        "euc-kr" => Ok(SerialEncoding::EucKr),
        "utf-16le" => Ok(SerialEncoding::Utf16Le),
        "utf-16be" => Ok(SerialEncoding::Utf16Be),
        "latin1" => Ok(SerialEncoding::Latin1),
        unexpected => Err(format!("unsupported serial encoding: {unexpected}")),
    }
}

fn serial_encoding_label(encoding: SerialEncoding) -> &'static str {
    match encoding {
        SerialEncoding::Ascii => "ASCII",
        SerialEncoding::Utf8 => "UTF-8",
        SerialEncoding::Gbk => "GBK",
        SerialEncoding::Big5 => "Big5",
        SerialEncoding::ShiftJis => "Shift_JIS",
        SerialEncoding::EucKr => "EUC-KR",
        SerialEncoding::Utf16Le => "UTF-16LE",
        SerialEncoding::Utf16Be => "UTF-16BE",
        SerialEncoding::Latin1 => "Latin-1",
    }
}

fn encode_terminal_input(
    input: &str,
    line_ending: SerialLineEnding,
    encoding: SerialEncoding,
) -> Result<Vec<u8>, String> {
    let normalized = match line_ending {
        SerialLineEnding::CrLf => normalize_line_endings(input, "\r\n"),
        SerialLineEnding::Cr => normalize_line_endings(input, "\r"),
        SerialLineEnding::Lf => normalize_line_endings(input, "\n"),
    };

    match encoding {
        SerialEncoding::Ascii => normalized
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
        SerialEncoding::Utf8 => Ok(normalized.into_bytes()),
        SerialEncoding::Latin1 => normalized
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
        SerialEncoding::Gbk
        | SerialEncoding::Big5
        | SerialEncoding::ShiftJis
        | SerialEncoding::EucKr
        | SerialEncoding::Utf16Le
        | SerialEncoding::Utf16Be => {
            let encoding_impl = match encoding {
                SerialEncoding::Gbk => GBK,
                SerialEncoding::Big5 => BIG5,
                SerialEncoding::ShiftJis => SHIFT_JIS,
                SerialEncoding::EucKr => EUC_KR,
                SerialEncoding::Utf16Le => UTF_16LE,
                SerialEncoding::Utf16Be => UTF_16BE,
                _ => unreachable!("handled above"),
            };
            let (encoded, _, had_errors) = encoding_impl.encode(&normalized);
            if had_errors {
                return Err(format!(
                    "input contains characters that cannot be encoded as {}",
                    serial_encoding_label(encoding)
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

fn decode_serial_output(bytes: &[u8], encoding: SerialEncoding) -> String {
    match encoding {
        SerialEncoding::Ascii => bytes
            .iter()
            .map(|byte| {
                if *byte <= 0x7f {
                    char::from(*byte)
                } else {
                    '\u{FFFD}'
                }
            })
            .collect(),
        SerialEncoding::Utf8 => String::from_utf8_lossy(bytes).to_string(),
        SerialEncoding::Latin1 => bytes.iter().map(|byte| char::from(*byte)).collect(),
        SerialEncoding::Gbk
        | SerialEncoding::Big5
        | SerialEncoding::ShiftJis
        | SerialEncoding::EucKr
        | SerialEncoding::Utf16Le
        | SerialEncoding::Utf16Be => {
            let encoding_impl = match encoding {
                SerialEncoding::Gbk => GBK,
                SerialEncoding::Big5 => BIG5,
                SerialEncoding::ShiftJis => SHIFT_JIS,
                SerialEncoding::EucKr => EUC_KR,
                SerialEncoding::Utf16Le => UTF_16LE,
                SerialEncoding::Utf16Be => UTF_16BE,
                _ => unreachable!("handled above"),
            };
            let (decoded, _, _) = encoding_impl.decode(bytes);
            decoded.into_owned()
        }
    }
}

fn spawn_serial_reader(
    app_handle: AppHandle,
    terminal_id: String,
    port_name: String,
    mut reader: SerialPort,
    encoding: SerialEncoding,
    closed: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending_bytes = Vec::new();
        let mut last_flush = Instant::now();
        let mut rx_seq = 0_u64;
        let mut disconnect_reason = format!("串口 {port_name} 已关闭");

        let _ = reader.set_read_timeout(SERIAL_READ_TIMEOUT);
        while !closed.load(Ordering::Relaxed) {
            match reader.read(&mut buffer) {
                Ok(0) => continue,
                Ok(byte_count) => {
                    pending_bytes.extend_from_slice(&buffer[..byte_count]);
                    if pending_bytes.len() >= SERIAL_OUTPUT_MAX_CHUNK_BYTES
                        || last_flush.elapsed() >= SERIAL_OUTPUT_FLUSH_INTERVAL
                    {
                        flush_serial_output(
                            &app_handle,
                            &terminal_id,
                            &mut pending_bytes,
                            encoding,
                            &mut last_flush,
                            &mut rx_seq,
                        );
                    }
                }
                Err(error) if error.kind() == ErrorKind::TimedOut => {
                    flush_serial_output(
                        &app_handle,
                        &terminal_id,
                        &mut pending_bytes,
                        encoding,
                        &mut last_flush,
                        &mut rx_seq,
                    );
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => {
                    flush_serial_output(
                        &app_handle,
                        &terminal_id,
                        &mut pending_bytes,
                        encoding,
                        &mut last_flush,
                        &mut rx_seq,
                    );
                    disconnect_reason = format!("读取串口 {port_name} 失败：{error}");
                    break;
                }
            }
        }
        flush_serial_output(
            &app_handle,
            &terminal_id,
            &mut pending_bytes,
            encoding,
            &mut last_flush,
            &mut rx_seq,
        );

        if !closed.load(Ordering::Relaxed) {
            emit_terminal_disconnected(&app_handle, &terminal_id, &disconnect_reason);
        }
        let serial_service = app_handle.state::<SerialService>();
        let _ = serial_service.close_terminal_by_id(&terminal_id);
    });
}

fn flush_serial_output(
    app_handle: &AppHandle,
    terminal_id: &str,
    pending_bytes: &mut Vec<u8>,
    encoding: SerialEncoding,
    last_flush: &mut Instant,
    rx_seq: &mut u64,
) {
    if pending_bytes.is_empty() {
        return;
    }

    let bytes = std::mem::take(pending_bytes);
    let output = decode_serial_output(&bytes, encoding);
    *last_flush = Instant::now();
    emit_serial_rx(app_handle, terminal_id, *rx_seq, bytes, output.clone());
    *rx_seq = rx_seq.saturating_add(1);
    emit_terminal_snapshot(app_handle, terminal_id, &output);
}

fn emit_serial_rx(
    app_handle: &AppHandle,
    terminal_id: &str,
    seq: u64,
    bytes: Vec<u8>,
    text: String,
) {
    if bytes.is_empty() && text.is_empty() {
        return;
    }

    let _ = app_handle.emit(
        SERIAL_RX_EVENT,
        SerialRxEvent {
            terminal_id: terminal_id.to_string(),
            seq,
            timestamp_us: current_timestamp_us(),
            bytes,
            text,
        },
    );
}

fn current_timestamp_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_micros().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn emit_terminal_snapshot(app_handle: &AppHandle, terminal_id: &str, output: &str) {
    if output.is_empty() {
        return;
    }

    let terminal_service = app_handle.state::<TerminalService>();
    if terminal_service.append_output(terminal_id, output).is_err() {
        return;
    }

    if let Ok(snapshot) = terminal_service.snapshot(terminal_id) {
        let _ = app_handle.emit(
            TERMINAL_SNAPSHOT_EVENT,
            TerminalOutputEvent {
                terminal_id: snapshot.terminal_id,
                status: snapshot.status,
                buffered_bytes: snapshot.buffered_bytes,
                buffer_preview: snapshot.buffer_preview,
                render_policy: snapshot.render_policy,
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

#[cfg(test)]
mod tests {
    use super::{encode_terminal_input, serial_line_ending, SerialEncoding, SerialLineEnding};

    #[test]
    fn serial_input_applies_crlf_line_ending() {
        assert_eq!(
            encode_terminal_input("show\n", SerialLineEnding::CrLf, SerialEncoding::Utf8).unwrap(),
            b"show\r\n"
        );
        assert_eq!(
            encode_terminal_input("show\r", SerialLineEnding::CrLf, SerialEncoding::Utf8).unwrap(),
            b"show\r\n"
        );
    }

    #[test]
    fn parses_default_serial_line_ending() {
        assert_eq!(serial_line_ending(None).unwrap(), SerialLineEnding::CrLf);
        assert_eq!(
            serial_line_ending(Some("lf")).unwrap(),
            SerialLineEnding::Lf
        );
    }
}
