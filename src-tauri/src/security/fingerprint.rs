pub fn normalize_fingerprint(input: &str) -> String {
    input
        .trim()
        .replace("SHA256:", "")
        .replace(':', "")
        .to_ascii_lowercase()
}

pub fn fingerprint_matches(expected: &str, actual: &str) -> bool {
    let expected = normalize_fingerprint(expected);
    let actual = normalize_fingerprint(actual);

    !expected.is_empty() && expected == actual
}

pub fn display_fingerprint(input: &str) -> String {
    let normalized = normalize_fingerprint(input);

    if normalized.is_empty() {
        return "SHA256:<empty>".to_string();
    }

    format!("SHA256:{normalized}")
}

#[cfg(test)]
mod tests {
    use super::{display_fingerprint, fingerprint_matches, normalize_fingerprint};

    #[test]
    fn strips_common_prefix_and_colons() {
        assert_eq!(normalize_fingerprint(" SHA256:AA:bb:CC "), "aabbcc");
    }

    #[test]
    fn compares_normalized_values() {
        assert!(fingerprint_matches("SHA256:AA:BB", "aa:bb"));
    }

    #[test]
    fn rejects_empty_fingerprints() {
        assert!(!fingerprint_matches("", ""));
    }

    #[test]
    fn formats_for_display() {
        assert_eq!(display_fingerprint("aa:bb"), "SHA256:aabb");
    }
}
