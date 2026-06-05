use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AppError {
    pub code: AppErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum AppErrorCode {
    ConnectionNotFound,
    UnsupportedCapability,
    HostKeyUnknown,
    HostKeyChanged,
    SecretUnavailable,
    ValidationFailed,
    Internal,
}

impl AppError {
    #[allow(dead_code)]
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::ValidationFailed,
            message: message.into(),
        }
    }

    #[allow(dead_code)]
    pub fn host_key_changed(host: &str) -> Self {
        Self {
            code: AppErrorCode::HostKeyChanged,
            message: format!("host key changed for {host}; connection blocked"),
        }
    }

    #[allow(dead_code)]
    pub fn into_command_error(self) -> String {
        format!("{:?}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn formats_command_error() {
        let message = AppError::validation("host is required").into_command_error();

        assert!(message.contains("ValidationFailed"));
        assert!(message.contains("host is required"));
    }

    #[test]
    fn describes_host_key_changes() {
        let error = AppError::host_key_changed("example.com");

        assert!(error.message.contains("connection blocked"));
    }
}
