use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::settings::AppSettings;
use crate::utils::app_paths;

pub struct SettingsStore {
    settings: Mutex<AppSettings>,
    path: Option<PathBuf>,
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self::with_path(app_paths::settings_path())
    }
}

impl SettingsStore {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            settings: Mutex::new(AppSettings::default()),
            path: None,
        }
    }

    pub fn with_path(path: PathBuf) -> Self {
        let settings = load_settings(&path).unwrap_or_default();

        Self {
            settings: Mutex::new(settings),
            path: Some(path),
        }
    }

    pub fn get(&self) -> Result<AppSettings, String> {
        Ok(self
            .settings
            .lock()
            .map_err(|_| "settings store lock poisoned".to_string())?
            .clone())
    }

    pub fn update(&self, settings: AppSettings) -> Result<AppSettings, String> {
        validate_settings(&settings)?;

        *self
            .settings
            .lock()
            .map_err(|_| "settings store lock poisoned".to_string())? = settings.clone();

        self.persist(&settings)?;

        Ok(settings)
    }

    fn persist(&self, settings: &AppSettings) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };

        write_settings(path, settings)
    }
}

fn load_settings(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        return Err("settings file does not exist".to_string());
    }

    let raw =
        fs::read_to_string(path).map_err(|error| format!("failed to read settings: {error}"))?;
    let settings: AppSettings =
        serde_json::from_str(&raw).map_err(|error| format!("failed to parse settings: {error}"))?;
    validate_settings(&settings)?;
    Ok(settings)
}

fn write_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create settings directory: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("failed to encode settings: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("failed to write settings: {error}"))
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if settings.theme.terminal_font_family.trim().is_empty() {
        return Err("terminal font family is required".to_string());
    }

    if !(8..=32).contains(&settings.theme.terminal_font_size) {
        return Err("terminal font size must be between 8 and 32".to_string());
    }

    let terminal_colors = &settings.theme.terminal_colors;
    let color_values = [
        ("background", &terminal_colors.background),
        ("foreground", &terminal_colors.foreground),
        ("cursor", &terminal_colors.cursor),
        ("selectionBackground", &terminal_colors.selection_background),
        ("black", &terminal_colors.black),
        ("red", &terminal_colors.red),
        ("green", &terminal_colors.green),
        ("yellow", &terminal_colors.yellow),
        ("blue", &terminal_colors.blue),
        ("magenta", &terminal_colors.magenta),
        ("cyan", &terminal_colors.cyan),
        ("white", &terminal_colors.white),
        ("brightBlack", &terminal_colors.bright_black),
        ("brightRed", &terminal_colors.bright_red),
        ("brightGreen", &terminal_colors.bright_green),
        ("brightYellow", &terminal_colors.bright_yellow),
        ("brightBlue", &terminal_colors.bright_blue),
        ("brightMagenta", &terminal_colors.bright_magenta),
        ("brightCyan", &terminal_colors.bright_cyan),
        ("brightWhite", &terminal_colors.bright_white),
    ];

    if let Some((name, _)) = color_values.iter().find(|(_, value)| !is_hex_color(value)) {
        return Err(format!("terminal color {name} must be #RRGGBB"));
    }

    let shortcuts = [
        &settings.keymap.command_palette,
        &settings.keymap.new_profile,
        &settings.keymap.close_tab,
    ];

    if shortcuts.iter().any(|shortcut| shortcut.trim().is_empty()) {
        return Err("shortcut bindings cannot be empty".to_string());
    }

    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();

    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::SettingsStore;
    use crate::domain::settings::AppSettings;
    use std::path::PathBuf;

    #[test]
    fn returns_default_settings() {
        let store = SettingsStore::in_memory();

        assert!(store.get().unwrap().security.require_host_key_verification);
    }

    #[test]
    fn rejects_empty_terminal_font() {
        let store = SettingsStore::in_memory();
        let mut settings = AppSettings::default();
        settings.theme.terminal_font_family.clear();

        assert!(store.update(settings).is_err());
    }

    #[test]
    fn rejects_empty_shortcut_binding() {
        let store = SettingsStore::in_memory();
        let mut settings = AppSettings::default();
        settings.keymap.close_tab.clear();

        assert_eq!(
            store.update(settings).unwrap_err(),
            "shortcut bindings cannot be empty"
        );
    }

    #[test]
    fn rejects_invalid_terminal_color() {
        let store = SettingsStore::in_memory();
        let mut settings = AppSettings::default();
        settings.theme.terminal_colors.background = "282C34".to_string();

        assert_eq!(
            store.update(settings).unwrap_err(),
            "terminal color background must be #RRGGBB"
        );
    }

    #[test]
    fn loads_legacy_settings_without_terminal_colors() {
        let path = test_path("settings-legacy-colors.json");
        let _ = std::fs::remove_file(&path);
        std::fs::write(
            &path,
            r##"{
              "theme": {
                "mode": "dark",
                "terminalFontFamily": "JetBrains Mono",
                "terminalFontSize": 14
              },
              "keymap": {
                "commandPalette": "Ctrl+Shift+P",
                "newProfile": "Ctrl+N",
                "closeTab": "Ctrl+W"
              },
              "security": {
                "requireHostKeyVerification": true,
                "redactSensitiveLogs": true,
                "allowInsecureWithoutWarning": false
              }
            }"##,
        )
        .unwrap();

        let store = SettingsStore::with_path(path.clone());
        let settings = store.get().unwrap();

        assert_eq!(settings.theme.terminal_font_family, "JetBrains Mono");
        assert_eq!(settings.theme.terminal_colors.background, "#282C34");
        assert!(matches!(
            settings.terminal.right_click_behavior,
            crate::domain::settings::TerminalRightClickBehavior::ContextMenu
        ));
        assert!(settings.terminal.confirm_multiline_paste);
        assert!(!settings.terminal.copy_rich_text);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn persists_settings_to_config_file() {
        let path = test_path("settings-persist.json");
        let _ = std::fs::remove_file(&path);

        let store = SettingsStore::with_path(path.clone());
        let mut settings = AppSettings::default();
        settings.theme.terminal_font_family = "JetBrains Mono".to_string();

        store.update(settings).unwrap();

        let reloaded = SettingsStore::with_path(path.clone());
        assert_eq!(
            reloaded.get().unwrap().theme.terminal_font_family,
            "JetBrains Mono"
        );

        let _ = std::fs::remove_file(path);
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("portiva-{name}-{}", std::process::id()))
    }
}
