import type { AppSettings } from "../../shared/types";
import {
  resolveTerminalPalette,
  terminalColorPresets,
  type TerminalColorKey,
} from "../../shared/terminalThemes";
import { Button, TextInput } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface TerminalPaletteSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

const terminalColorPresetOptions = [terminalColorPresets.dark, terminalColorPresets.light];
const terminalColorFieldGroups: Array<{
  fields: Array<{ key: TerminalColorKey; label: string }>;
  title: string;
}> = [
  {
    title: "基础",
    fields: [
      { key: "background", label: "背景" },
      { key: "foreground", label: "文字" },
      { key: "cursor", label: "光标" },
      { key: "selectionBackground", label: "选区" },
    ],
  },
  {
    title: "ANSI",
    fields: [
      { key: "black", label: "黑" },
      { key: "red", label: "红" },
      { key: "green", label: "绿" },
      { key: "yellow", label: "黄" },
      { key: "blue", label: "蓝" },
      { key: "magenta", label: "紫" },
      { key: "cyan", label: "青" },
      { key: "white", label: "白" },
    ],
  },
  {
    title: "亮色 ANSI",
    fields: [
      { key: "brightBlack", label: "亮黑" },
      { key: "brightRed", label: "亮红" },
      { key: "brightGreen", label: "亮绿" },
      { key: "brightYellow", label: "亮黄" },
      { key: "brightBlue", label: "亮蓝" },
      { key: "brightMagenta", label: "亮紫" },
      { key: "brightCyan", label: "亮青" },
      { key: "brightWhite", label: "亮白" },
    ],
  },
];
const terminalPaletteSampleKeys: TerminalColorKey[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];
const hexColorPattern = /^#[0-9a-fA-F]{6}$/;

function normalizeHexColor(value: string) {
  return value.trim().toUpperCase();
}

function isHexColor(value: string) {
  return hexColorPattern.test(value.trim());
}

export function TerminalPaletteSettings({ onSaveSettings, settings }: TerminalPaletteSettingsProps) {
  const updateTheme = (theme: Partial<AppSettings["theme"]>) =>
    onSaveSettings({ ...settings, theme: { ...settings.theme, ...theme } });
  const terminalPalette = resolveTerminalPalette(settings.theme);
  const updateTerminalPreset = (presetId: "dark" | "light") => {
    updateTheme({
      terminalColorPreset: presetId,
      terminalColors: terminalColorPresets[presetId].colors,
    });
  };
  const updateTerminalColor = (key: TerminalColorKey, value: string) => {
    if (!isHexColor(value)) {
      return;
    }

    updateTheme({
      terminalColorPreset: "custom",
      terminalColors: {
        ...terminalPalette,
        [key]: normalizeHexColor(value),
      },
    });
  };

  return (
    <section className="settings-block appearance-settings-block terminal-palette-settings">
      <SettingsSectionHeader title="终端配色" />
      <div className="terminal-palette-presets" aria-label="终端配色预设">
        {terminalColorPresetOptions.map((preset) => (
          <Button
            active={settings.theme.terminalColorPreset === preset.id}
            key={preset.id}
            onClick={() => updateTerminalPreset(preset.id)}
            title={`套用${preset.label}终端配色`}
            tone="muted"
          >
            <span
              className="terminal-preset-swatch"
              style={{
                background: preset.colors.background,
                borderColor: preset.colors.cursor,
                color: preset.colors.foreground,
              }}
            >
              <i style={{ background: preset.colors.red }} />
              <i style={{ background: preset.colors.green }} />
              <i style={{ background: preset.colors.blue }} />
            </span>
            <strong>{preset.label}</strong>
            <small>{preset.description}</small>
          </Button>
        ))}
        <Button
          active={settings.theme.terminalColorPreset === "custom"}
          onClick={() =>
            updateTheme({
              terminalColorPreset: "custom",
              terminalColors: terminalPalette,
            })
          }
          title="编辑自定义终端配色"
          tone="muted"
        >
          <span
            className="terminal-preset-swatch"
            style={{
              background: terminalPalette.background,
              borderColor: terminalPalette.cursor,
              color: terminalPalette.foreground,
            }}
          >
            <i style={{ background: terminalPalette.red }} />
            <i style={{ background: terminalPalette.yellow }} />
            <i style={{ background: terminalPalette.cyan }} />
          </span>
          <strong>自定义</strong>
          <small>修改任意颜色后自动启用</small>
        </Button>
      </div>
      <div
        className="terminal-palette-preview"
        style={{
          background: terminalPalette.background,
          borderColor: terminalPalette.selectionBackground,
          color: terminalPalette.foreground,
          fontFamily: settings.theme.terminalFontFamily,
        }}
      >
        <span>
          <b style={{ color: terminalPalette.green }}>deploy</b>
          <span style={{ color: terminalPalette.foreground }}>@</span>
          <b style={{ color: terminalPalette.blue }}>prod-web</b>
          <span style={{ color: terminalPalette.foreground }}>:~$ ssh root@10.0.0.8</span>
        </span>
        <span style={{ color: terminalPalette.yellow }}>warning: config changed, reload pending</span>
        <span style={{ color: terminalPalette.cyan }}>200 OK</span>
        <div className="terminal-ansi-strip" aria-label="ANSI 颜色预览">
          {terminalPaletteSampleKeys.map((key) => (
            <i key={key} style={{ background: terminalPalette[key] }} title={key} />
          ))}
        </div>
      </div>
      <div className="terminal-color-groups">
        {terminalColorFieldGroups.map((group) => (
          <div className="terminal-color-group" key={group.title}>
            <strong>{group.title}</strong>
            <div className="terminal-color-grid">
              {group.fields.map((field) => {
                const value = terminalPalette[field.key];

                return (
                  <label className="terminal-color-field" key={field.key}>
                    <span>{field.label}</span>
                    <Button
                      aria-label={`${field.label}颜色选择器`}
                      className="terminal-color-swatch-button"
                      style={{ background: value }}
                      title={`${field.label}：${value}`}
                      tone="muted"
                    />
                    <TextInput
                      mono
                      maxLength={7}
                      pattern="#[0-9a-fA-F]{6}"
                      type="text"
                      value={value}
                      onChange={(event) => updateTerminalColor(field.key, event.currentTarget.value)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
