const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "passphrase",
    "private_key",
    "privateKey",
    "token",
    "authorization",
    "secret",
];

pub fn redact(input: &str) -> String {
    input
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();

    if SENSITIVE_KEYS
        .iter()
        .any(|key| lower.contains(&key.to_ascii_lowercase()))
    {
        return "[REDACTED]".to_string();
    }

    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn removes_sensitive_lines() {
        let input = "host=example\npassword=hunter2\nuser=root";

        assert_eq!(redact(input), "host=example\n[REDACTED]\nuser=root");
    }
}
