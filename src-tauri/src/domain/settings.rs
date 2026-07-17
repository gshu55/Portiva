use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: ThemeSettings,
    pub keymap: KeymapSettings,
    pub security: SecuritySettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    pub mode: ThemeMode,
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    #[serde(default)]
    pub terminal_color_preset: TerminalColorPreset,
    #[serde(default)]
    pub terminal_colors: TerminalColorPalette,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeMode {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalColorPreset {
    #[default]
    Dark,
    Light,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalColorPalette {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection_background: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeymapSettings {
    pub command_palette: String,
    pub new_profile: String,
    pub open_local_terminal: String,
    pub open_serial_terminal: String,
    pub close_tab: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    pub require_host_key_verification: bool,
    pub redact_sensitive_logs: bool,
    pub allow_insecure_without_warning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default = "default_confirm_multiline_paste")]
    pub confirm_multiline_paste: bool,
    #[serde(default)]
    pub copy_rich_text: bool,
    #[serde(default)]
    pub right_click_behavior: TerminalRightClickBehavior,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalRightClickBehavior {
    Disabled,
    #[default]
    ContextMenu,
    Paste,
    CopyOrPaste,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemeSettings {
                mode: ThemeMode::Dark,
                terminal_font_family: "Cascadia Mono".to_string(),
                terminal_font_size: 13,
                terminal_color_preset: TerminalColorPreset::Dark,
                terminal_colors: TerminalColorPalette::default(),
            },
            keymap: KeymapSettings {
                command_palette: "Ctrl+Shift+P".to_string(),
                new_profile: "Ctrl+N".to_string(),
                open_local_terminal: "Ctrl+Alt+T".to_string(),
                open_serial_terminal: "Ctrl+Alt+S".to_string(),
                close_tab: "Ctrl+W".to_string(),
            },
            security: SecuritySettings {
                require_host_key_verification: true,
                redact_sensitive_logs: true,
                allow_insecure_without_warning: false,
            },
            terminal: TerminalSettings::default(),
        }
    }
}

impl Default for KeymapSettings {
    fn default() -> Self {
        Self {
            command_palette: "Ctrl+Shift+P".to_string(),
            new_profile: "Ctrl+N".to_string(),
            open_local_terminal: "Ctrl+Alt+T".to_string(),
            open_serial_terminal: "Ctrl+Alt+S".to_string(),
            close_tab: "Ctrl+W".to_string(),
        }
    }
}

impl Default for TerminalColorPalette {
    fn default() -> Self {
        Self {
            background: "#282C34".to_string(),
            foreground: "#ABB2BF".to_string(),
            cursor: "#528BFF".to_string(),
            selection_background: "#3E4451".to_string(),
            black: "#5C6370".to_string(),
            red: "#E06C75".to_string(),
            green: "#98C379".to_string(),
            yellow: "#E5C07B".to_string(),
            blue: "#61AFEF".to_string(),
            magenta: "#C678DD".to_string(),
            cyan: "#56B6C2".to_string(),
            white: "#ABB2BF".to_string(),
            bright_black: "#4B5263".to_string(),
            bright_red: "#BE5046".to_string(),
            bright_green: "#98C379".to_string(),
            bright_yellow: "#D19A66".to_string(),
            bright_blue: "#61AFEF".to_string(),
            bright_magenta: "#C678DD".to_string(),
            bright_cyan: "#56B6C2".to_string(),
            bright_white: "#FFFFFF".to_string(),
        }
    }
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            confirm_multiline_paste: true,
            copy_rich_text: false,
            right_click_behavior: TerminalRightClickBehavior::ContextMenu,
        }
    }
}

fn default_confirm_multiline_paste() -> bool {
    true
}
