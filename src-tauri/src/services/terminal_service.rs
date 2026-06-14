use std::collections::HashMap;
use std::sync::Mutex;

use crate::domain::terminal::{
    TerminalRenderPolicy, TerminalSession, TerminalSessionStatus, TerminalSize, TerminalSnapshot,
};

pub struct TerminalOutputMetadata {
    pub status: TerminalSessionStatus,
    pub buffered_bytes: usize,
    pub render_policy: TerminalRenderPolicy,
}

#[derive(Default)]
pub struct TerminalService {
    sessions: Mutex<HashMap<String, TerminalSession>>,
    buffers: Mutex<HashMap<String, String>>,
    next_sequence: Mutex<u64>,
}

impl TerminalService {
    pub fn attach(
        &self,
        connection_id: String,
        size: TerminalSize,
    ) -> Result<TerminalSession, String> {
        let mut next_sequence = self
            .next_sequence
            .lock()
            .map_err(|_| "terminal sequence lock poisoned".to_string())?;
        *next_sequence = next_sequence.saturating_add(1);

        let session = TerminalSession {
            id: format!("terminal-{connection_id}-{next_sequence}"),
            connection_id,
            size,
            status: TerminalSessionStatus::Attached,
            render_policy: TerminalRenderPolicy::default().sanitized(),
        };

        self.sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?
            .insert(session.id.clone(), session.clone());

        Ok(session)
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?;

        if !sessions.contains_key(terminal_id) {
            return Err(format!("terminal not found: {terminal_id}"));
        }
        drop(sessions);

        let mut buffers = self
            .buffers
            .lock()
            .map_err(|_| "terminal buffer lock poisoned".to_string())?;
        let buffer = buffers.entry(terminal_id.to_string()).or_default();
        buffer.push_str(data);
        truncate_terminal_buffer(buffer);
        Ok(())
    }

    pub fn resize(&self, terminal_id: &str, size: TerminalSize) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?;

        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| format!("terminal not found: {terminal_id}"))?;

        session.size = size;
        Ok(())
    }

    pub fn append_disconnect_notice(&self, terminal_id: &str, reason: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?;

        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| format!("terminal not found: {terminal_id}"))?;

        if matches!(session.status, TerminalSessionStatus::Closed) {
            return Ok(());
        }

        session.status = TerminalSessionStatus::Closed;
        drop(sessions);

        self.append_output(terminal_id, &terminal_disconnect_notice(reason))
    }

    pub fn mark_attached(&self, terminal_id: &str) -> Result<TerminalSession, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?;

        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| format!("terminal not found: {terminal_id}"))?;

        session.status = TerminalSessionStatus::Attached;
        Ok(session.clone())
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?
            .remove(terminal_id);
        self.buffers
            .lock()
            .map_err(|_| "terminal buffer lock poisoned".to_string())?
            .remove(terminal_id);

        Ok(())
    }

    pub fn session(&self, terminal_id: &str) -> Result<TerminalSession, String> {
        self.sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| format!("terminal not found: {terminal_id}"))
    }

    pub fn append_output(&self, terminal_id: &str, output: &str) -> Result<(), String> {
        self.append_output_metadata(terminal_id, output).map(|_| ())
    }

    pub fn append_output_metadata(
        &self,
        terminal_id: &str,
        output: &str,
    ) -> Result<TerminalOutputMetadata, String> {
        let (status, render_policy) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "terminal service lock poisoned".to_string())?;
            let session = sessions
                .get(terminal_id)
                .ok_or_else(|| format!("terminal not found: {terminal_id}"))?;

            (session.status.clone(), session.render_policy.clone())
        };

        let mut buffers = self
            .buffers
            .lock()
            .map_err(|_| "terminal buffer lock poisoned".to_string())?;
        let buffer = buffers.entry(terminal_id.to_string()).or_default();
        buffer.push_str(output);
        truncate_terminal_buffer(buffer);

        Ok(TerminalOutputMetadata {
            status,
            buffered_bytes: buffer.len(),
            render_policy,
        })
    }

    pub fn close_by_connection(&self, connection_id: &str) -> Result<usize, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?;
        let terminal_ids = sessions
            .values()
            .filter(|session| session.connection_id == connection_id)
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();

        for terminal_id in &terminal_ids {
            sessions.remove(terminal_id);
        }
        drop(sessions);

        let mut buffers = self
            .buffers
            .lock()
            .map_err(|_| "terminal buffer lock poisoned".to_string())?;
        for terminal_id in &terminal_ids {
            buffers.remove(terminal_id);
        }

        Ok(terminal_ids.len())
    }

    pub fn snapshot(&self, terminal_id: &str) -> Result<TerminalSnapshot, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal service lock poisoned".to_string())?;
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| format!("terminal not found: {terminal_id}"))?;
        let buffer = self
            .buffers
            .lock()
            .map_err(|_| "terminal buffer lock poisoned".to_string())?
            .get(terminal_id)
            .cloned()
            .unwrap_or_default();

        Ok(TerminalSnapshot {
            terminal_id: terminal_id.to_string(),
            status: session.status.clone(),
            buffered_bytes: buffer.len(),
            buffer_preview: buffer,
            render_policy: session.render_policy.clone(),
        })
    }
}

fn truncate_terminal_buffer(buffer: &mut String) {
    const MAX_BUFFER_BYTES: usize = 256 * 1024;

    if buffer.len() <= MAX_BUFFER_BYTES {
        return;
    }

    let mut split_at = buffer.len().saturating_sub(MAX_BUFFER_BYTES);
    while split_at < buffer.len() && !buffer.is_char_boundary(split_at) {
        split_at += 1;
    }
    buffer.drain(..split_at);
}

pub fn terminal_disconnect_notice(reason: &str) -> String {
    format!(
        "\r\n\r\n--- 终端连接已断开 ----------------------------------------\r\n{reason}\r\n按 R 键重新启动会话，或按 Enter 键退出标签页。\r\n------------------------------------------------------------------\r\n"
    )
}

pub fn drain_utf8_terminal_output(pending_bytes: &mut Vec<u8>, force: bool) -> String {
    if pending_bytes.is_empty() {
        return String::new();
    }

    match std::str::from_utf8(pending_bytes) {
        Ok(output) => {
            let output = output.to_string();
            pending_bytes.clear();
            output
        }
        Err(error) if !force && error.error_len().is_none() => {
            let valid_up_to = error.valid_up_to();
            if valid_up_to == 0 {
                return String::new();
            }

            let output = String::from_utf8_lossy(&pending_bytes[..valid_up_to]).to_string();
            pending_bytes.drain(..valid_up_to);
            output
        }
        Err(_) => {
            let bytes = std::mem::take(pending_bytes);
            String::from_utf8_lossy(&bytes).to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{drain_utf8_terminal_output, TerminalService};
    use crate::domain::terminal::{TerminalSessionStatus, TerminalSize};

    #[test]
    fn tracks_buffered_terminal_bytes() {
        let service = TerminalService::default();
        let session = service
            .attach(
                "connection-1".to_string(),
                TerminalSize {
                    cols: 80,
                    rows: 24,
                    width_px: 800,
                    height_px: 600,
                },
            )
            .unwrap();

        service.write(&session.id, "hello").unwrap();

        assert_eq!(service.snapshot(&session.id).unwrap().buffered_bytes, 5);
        assert_eq!(
            service.snapshot(&session.id).unwrap().buffer_preview,
            "hello"
        );
    }

    #[test]
    fn attach_creates_distinct_terminals_for_same_connection() {
        let service = TerminalService::default();
        let size = TerminalSize {
            cols: 80,
            rows: 24,
            width_px: 800,
            height_px: 600,
        };
        let first = service
            .attach("connection-1".to_string(), size.clone())
            .unwrap();
        let second = service.attach("connection-1".to_string(), size).unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(service.close_by_connection("connection-1").unwrap(), 2);
    }

    #[test]
    fn close_by_connection_removes_matching_sessions_and_buffers() {
        let service = TerminalService::default();
        let first = service
            .attach(
                "connection-1".to_string(),
                TerminalSize {
                    cols: 80,
                    rows: 24,
                    width_px: 800,
                    height_px: 600,
                },
            )
            .unwrap();
        let second = service
            .attach(
                "connection-2".to_string(),
                TerminalSize {
                    cols: 100,
                    rows: 30,
                    width_px: 1000,
                    height_px: 700,
                },
            )
            .unwrap();

        service.write(&first.id, "secret").unwrap();
        service.write(&second.id, "still-open").unwrap();

        assert_eq!(service.close_by_connection("connection-1").unwrap(), 1);
        assert!(service.snapshot(&first.id).is_err());
        assert_eq!(
            service.snapshot(&second.id).unwrap().buffered_bytes,
            "still-open".len()
        );
    }

    #[test]
    fn append_disconnect_notice_marks_closed_once() {
        let service = TerminalService::default();
        let session = service
            .attach(
                "connection-1".to_string(),
                TerminalSize {
                    cols: 80,
                    rows: 24,
                    width_px: 800,
                    height_px: 600,
                },
            )
            .unwrap();

        service
            .append_disconnect_notice(&session.id, "SSH keepalive 超时")
            .unwrap();
        service
            .append_disconnect_notice(&session.id, "重复断开事件")
            .unwrap();

        let closed = service.session(&session.id).unwrap();
        let snapshot = service.snapshot(&session.id).unwrap();

        assert!(matches!(closed.status, TerminalSessionStatus::Closed));
        assert_eq!(snapshot.buffer_preview.matches("终端连接已断开").count(), 1);
        assert!(snapshot.buffer_preview.contains("SSH keepalive 超时"));
        assert!(!snapshot.buffer_preview.contains("重复断开事件"));
    }

    #[test]
    fn utf8_terminal_output_keeps_incomplete_tail_for_next_flush() {
        let mut pending = "中".as_bytes().to_vec();
        let tail = pending.pop().unwrap();

        assert_eq!(drain_utf8_terminal_output(&mut pending, false), "");

        pending.push(tail);
        assert_eq!(drain_utf8_terminal_output(&mut pending, false), "中");
        assert!(pending.is_empty());
    }

    #[test]
    fn utf8_terminal_output_forces_remaining_bytes_on_close() {
        let mut pending = vec![0xe4, 0xb8];

        assert_eq!(drain_utf8_terminal_output(&mut pending, true), "�");
        assert!(pending.is_empty());
    }
}
