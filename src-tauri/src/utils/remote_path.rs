pub fn normalize_remote_path(input: &str) -> String {
    let normalized_separators = input.replace('\\', "/");
    let mut parts = Vec::new();
    let is_absolute = input.starts_with('/');

    for part in normalized_separators.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }

    let normalized = parts.join("/");

    if is_absolute {
        if normalized.is_empty() {
            "/".to_string()
        } else {
            format!("/{normalized}")
        }
    } else if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

pub fn join_remote_path(base: &str, name: &str) -> String {
    let mut joined = normalize_remote_path(base);

    if joined == "." {
        joined.clear();
    }

    if !joined.ends_with('/') && !joined.is_empty() {
        joined.push('/');
    }

    joined.push_str(name.trim_matches('/'));
    normalize_remote_path(&joined)
}

#[cfg(test)]
mod tests {
    use super::{join_remote_path, normalize_remote_path};

    #[test]
    fn normalizes_absolute_paths() {
        assert_eq!(
            normalize_remote_path("/srv//app/./releases/../log"),
            "/srv/app/log"
        );
        assert_eq!(normalize_remote_path("/"), "/");
    }

    #[test]
    fn normalizes_relative_paths() {
        assert_eq!(
            normalize_remote_path("deploy\\logs/../current"),
            "deploy/current"
        );
    }

    #[test]
    fn joins_remote_paths() {
        assert_eq!(
            join_remote_path("/srv/app/", "/deploy.log"),
            "/srv/app/deploy.log"
        );
    }
}
