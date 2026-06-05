use std::path::PathBuf;

pub fn portiva_config_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    home.join(".portiva")
}

pub fn profiles_path() -> PathBuf {
    portiva_config_dir().join("profiles.json")
}

pub fn settings_path() -> PathBuf {
    portiva_config_dir().join("settings.json")
}

pub fn known_hosts_path() -> PathBuf {
    portiva_config_dir().join("known_hosts.json")
}

pub fn secrets_metadata_path() -> PathBuf {
    portiva_config_dir().join("secrets.json")
}

pub fn recent_connections_path() -> PathBuf {
    portiva_config_dir().join("recent.json")
}

pub fn logs_path() -> PathBuf {
    portiva_config_dir().join("logs.json")
}

pub fn http_console_database_path() -> PathBuf {
    portiva_config_dir().join("http_console.sqlite")
}
