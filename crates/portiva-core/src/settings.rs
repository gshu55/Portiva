//! Portable preferences and input policy. No renderer or platform key codes are stored here.
use std::{path::PathBuf, str::FromStr};

use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeMode {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PalettePreset {
    #[default]
    Dark,
    Light,
    Dracula,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalPalette {
    pub background: u32,
    pub foreground: u32,
    pub cursor: u32,
    pub selection: u32,
    pub ansi: [u32; 16],
}

impl Default for TerminalPalette {
    fn default() -> Self {
        Self::preset(PalettePreset::Dark)
    }
}

impl TerminalPalette {
    pub fn preset(preset: PalettePreset) -> Self {
        match preset {
            PalettePreset::Dark | PalettePreset::Custom => Self {
                background: 0x282c34,
                foreground: 0xabb2bf,
                cursor: 0x528bff,
                selection: 0x3e4451,
                ansi: [
                    0x5c6370, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xabb2bf,
                    0x4b5263, 0xbe5046, 0x98c379, 0xd19a66, 0x61afef, 0xc678dd, 0x56b6c2, 0xffffff,
                ],
            },
            PalettePreset::Light => Self {
                background: 0xf7fafb,
                foreground: 0x26333a,
                cursor: 0x147d70,
                selection: 0xd7eee9,
                ansi: [
                    0x142027, 0xb14b28, 0x4f7d22, 0x8a6500, 0x286fa8, 0x8a4fa8, 0x147d70, 0xdde5e8,
                    0x66747c, 0xc45d38, 0x669528, 0xa77900, 0x347fbd, 0x9b60b8, 0x1d9485, 0xffffff,
                ],
            },
            PalettePreset::Dracula => Self {
                background: 0x282a36,
                foreground: 0xf8f8f2,
                cursor: 0xf8f8f2,
                selection: 0x44475a,
                ansi: [
                    0x21222c, 0xff5555, 0x50fa7b, 0xf1fa8c, 0xbd93f9, 0xff79c6, 0x8be9fd, 0xf8f8f2,
                    0x6272a4, 0xff6e6e, 0x69ff94, 0xffffa5, 0xd6acff, 0xff92df, 0xa4ffff, 0xffffff,
                ],
            },
        }
    }

    pub fn colors(&self) -> [u32; 20] {
        let mut colors = [0; 20];
        colors[..4].copy_from_slice(&[
            self.background,
            self.foreground,
            self.cursor,
            self.selection,
        ]);
        colors[4..].copy_from_slice(&self.ansi);
        colors
    }

    pub fn muted_foreground(&self) -> u32 {
        let channel = |shift: u32| -> u32 {
            (((self.foreground >> shift) & 0xff) * 2 + ((self.ansi[8] >> shift) & 0xff)) / 3
        };
        channel(16) << 16 | channel(8) << 8 | channel(0)
    }

    pub fn from_colors(colors: [u32; 20]) -> Self {
        let mut ansi = [0; 16];
        ansi.copy_from_slice(&colors[4..]);
        Self {
            background: colors[0],
            foreground: colors[1],
            cursor: colors[2],
            selection: colors[3],
            ansi,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RightClickBehavior {
    Disabled,
    #[default]
    ContextMenu,
    Paste,
    CopyOrPaste,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackgroundSettings {
    pub enabled: bool,
    pub image: Option<PathBuf>,
    pub opacity: u8,
    pub blur: u8,
}
impl Default for BackgroundSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            image: None,
            opacity: 20,
            blur: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    pub font_family: String,
    pub font_size: u8,
    pub palette_preset: PalettePreset,
    pub custom_palette: TerminalPalette,
    pub right_click: RightClickBehavior,
    pub confirm_multiline_paste: bool,
    pub copy_on_ctrl_c_when_selected: bool,
    pub highlighting: TerminalHighlighting,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodeLanguage {
    #[default]
    Auto,
    Html,
    Css,
    CSharp,
    JavaScript,
    Json,
    Rust,
    Python,
    Shell,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalHighlighting {
    pub logs: bool,
    pub code: bool,
    pub language: CodeLanguage,
}

impl Default for TerminalHighlighting {
    fn default() -> Self {
        Self {
            logs: true,
            code: true,
            language: CodeLanguage::Auto,
        }
    }
}
impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_family: if cfg!(target_os = "macos") {
                "Menlo"
            } else if cfg!(target_os = "windows") {
                "Consolas"
            } else {
                "DejaVu Sans Mono"
            }
            .into(),
            font_size: 14,
            palette_preset: PalettePreset::Dark,
            custom_palette: TerminalPalette::default(),
            right_click: RightClickBehavior::ContextMenu,
            confirm_multiline_paste: true,
            copy_on_ctrl_c_when_selected: true,
            highlighting: TerminalHighlighting::default(),
        }
    }
}
impl TerminalSettings {
    pub fn palette(&self) -> TerminalPalette {
        if self.palette_preset == PalettePreset::Custom {
            self.custom_palette.clone()
        } else {
            TerminalPalette::preset(self.palette_preset)
        }
    }
    pub fn line_height(&self) -> f32 {
        f32::from(self.font_size) * 1.5
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeymapSettings {
    pub copy: String,
    pub paste: String,
    pub open_settings: String,
    pub new_connection: String,
}
impl Default for KeymapSettings {
    fn default() -> Self {
        Self {
            copy: "Ctrl+Shift+C".into(),
            paste: "Ctrl+Shift+V".into(),
            open_settings: "Ctrl+,".into(),
            new_connection: "Ctrl+N".into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: ThemeMode,
    pub background: BackgroundSettings,
    pub terminal: TerminalSettings,
    pub keymap: KeymapSettings,
    pub sftp_panel: SftpPanelSettings,
}

/// Last-used panel layout, in logical pixels and independent of the desktop renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SftpPanelSettings {
    pub visible: bool,
    pub left: bool,
    pub width: u16,
}

impl Default for SftpPanelSettings {
    fn default() -> Self {
        Self {
            visible: false,
            left: false,
            width: 360,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (260..=1600).contains(&self.sftp_panel.width),
            "SFTP 栏宽应为 260–1600"
        );
        ensure!(
            (9..=36).contains(&self.terminal.font_size),
            "终端字号应为 9–36"
        );
        ensure!(
            !self.terminal.font_family.trim().is_empty()
                && self.terminal.font_family.len() <= 200
                && !self.terminal.font_family.chars().any(char::is_control),
            "请填写有效字体名称"
        );
        ensure!(self.background.opacity <= 100, "背景显示强度应为 0–100");
        ensure!(self.background.blur <= 24, "背景模糊应为 0–24");
        ensure!(
            self.terminal
                .custom_palette
                .colors()
                .iter()
                .all(|c| *c <= 0xffffff),
            "颜色应为 #RRGGBB"
        );
        let shortcuts = [
            &self.keymap.copy,
            &self.keymap.paste,
            &self.keymap.open_settings,
            &self.keymap.new_connection,
        ]
        .into_iter()
        .map(|s| s.parse::<Shortcut>())
        .collect::<Result<Vec<_>>>()?;
        for (index, shortcut) in shortcuts.iter().enumerate() {
            ensure!(!shortcuts[..index].contains(shortcut), "快捷键不能重复");
        }
        let fallback = "Shift+Insert".parse::<Shortcut>()?;
        ensure!(
            shortcuts
                .iter()
                .enumerate()
                .all(|(i, s)| i == 1 || s != &fallback),
            "Shift+Insert 保留用于终端粘贴"
        );
        Ok(())
    }
}

/// A portable shortcut; the desktop adapter supplies its normalized key and modifier flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shortcut {
    pub key: String,
    pub control: bool,
    pub shift: bool,
    pub alt: bool,
    pub platform: bool,
}
impl FromStr for Shortcut {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> Result<Self> {
        let mut result = Self {
            key: String::new(),
            control: false,
            shift: false,
            alt: false,
            platform: false,
        };
        for part in value.trim().split('+') {
            let part = part.trim().to_ascii_lowercase();
            match part.as_str() {
                "ctrl" | "control" if !result.control => result.control = true,
                "shift" if !result.shift => result.shift = true,
                "alt" if !result.alt => result.alt = true,
                "cmd" | "command" | "super" if !result.platform => result.platform = true,
                key if result.key.is_empty()
                    && (key.chars().count() == 1
                        || matches!(
                            key,
                            "insert"
                                | "delete"
                                | "home"
                                | "end"
                                | "f1"
                                | "f2"
                                | "f3"
                                | "f4"
                                | "f5"
                                | "f6"
                                | "f7"
                                | "f8"
                                | "f9"
                                | "f10"
                                | "f11"
                                | "f12"
                        )) =>
                {
                    result.key = key.into()
                }
                _ => bail!("无效快捷键：{value}；例如 Ctrl+Shift+C"),
            }
        }
        ensure!(
            !result.key.is_empty()
                && (result.control
                    || result.alt
                    || result.platform
                    || result.shift && result.key == "insert"),
            "快捷键需包含 Ctrl、Alt 或 Cmd：{value}"
        );
        Ok(result)
    }
}
impl Shortcut {
    pub fn matches(
        &self,
        key: &str,
        control: bool,
        shift: bool,
        alt: bool,
        platform: bool,
    ) -> bool {
        self.key.eq_ignore_ascii_case(key)
            && self.control == control
            && self.shift == shift
            && self.alt == alt
            && self.platform == platform
    }
}

pub fn parse_color(value: &str) -> Result<u32> {
    let value = value.trim().trim_start_matches('#');
    ensure!(value.len() == 6 && value.is_ascii(), "颜色格式应为 #RRGGBB");
    Ok(u32::from_str_radix(value, 16)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_defaults_validation_and_shortcut_identity() -> Result<()> {
        assert_eq!(Settings::default().terminal.font_size, 14);
        let settings: Settings = serde_json::from_str(r#"{"terminal":{"fontSize":18}}"#)?;
        assert_eq!(settings.terminal.font_size, 18);
        assert_eq!(
            settings.terminal.highlighting,
            TerminalHighlighting::default()
        );
        assert_eq!(settings.sftp_panel, SftpPanelSettings::default());
        assert_eq!(
            settings.terminal.right_click,
            RightClickBehavior::ContextMenu
        );
        settings.validate()?;
        let mut invalid = settings.clone();
        invalid.keymap.paste = "control+shift+c".into();
        assert!(invalid.validate().is_err());
        assert!("Tab".parse::<Shortcut>().is_err());
        assert!("Ctrl+Ctrl+C".parse::<Shortcut>().is_err());
        let copy = settings.keymap.copy.parse::<Shortcut>()?;
        assert!(copy.matches("c", true, true, false, false));
        assert!(!copy.matches("c", true, false, false, false));
        assert_eq!(parse_color("#12ABef")?, 0x12abef);
        assert!(parse_color("#123").is_err());
        Ok(())
    }
}
