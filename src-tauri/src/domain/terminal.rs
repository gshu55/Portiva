use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
    pub width_px: u16,
    pub height_px: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub connection_id: String,
    pub size: TerminalSize,
    pub status: TerminalSessionStatus,
    pub render_policy: TerminalRenderPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalSessionStatus {
    Attached,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRenderPolicy {
    pub flush_interval_ms: u16,
    pub max_chunk_bytes: usize,
    pub scrollback_lines: usize,
}

impl Default for TerminalRenderPolicy {
    fn default() -> Self {
        Self {
            flush_interval_ms: 16,
            max_chunk_bytes: 32 * 1024,
            scrollback_lines: 10_000,
        }
    }
}

impl TerminalRenderPolicy {
    pub fn sanitized(self) -> Self {
        Self {
            flush_interval_ms: self.flush_interval_ms.clamp(8, 100),
            max_chunk_bytes: self.max_chunk_bytes.clamp(1024, 256 * 1024),
            scrollback_lines: self.scrollback_lines.clamp(1000, 100_000),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub terminal_id: String,
    pub status: TerminalSessionStatus,
    pub buffered_bytes: usize,
    pub buffer_preview: String,
    pub history_truncated: bool,
    pub render_policy: TerminalRenderPolicy,
}

#[cfg(test)]
mod tests {
    use super::TerminalRenderPolicy;

    #[test]
    fn sanitizes_render_policy_bounds() {
        let policy = TerminalRenderPolicy {
            flush_interval_ms: 1,
            max_chunk_bytes: 1,
            scrollback_lines: 1,
        }
        .sanitized();

        assert_eq!(policy.flush_interval_ms, 8);
        assert_eq!(policy.max_chunk_bytes, 1024);
        assert_eq!(policy.scrollback_lines, 1000);
    }

    #[test]
    fn keeps_reasonable_render_policy_values() {
        let policy = TerminalRenderPolicy::default().sanitized();

        assert_eq!(policy.flush_interval_ms, 16);
        assert_eq!(policy.max_chunk_bytes, 32 * 1024);
        assert_eq!(policy.scrollback_lines, 10_000);
    }
}
