import type { AppSettings } from "../../shared/types";
import type { IconName } from "../../shared/Icon";
import { SegmentedControl, Select, TextInput } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface ThemeSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

const customFontValue = "__custom__";
const terminalFontPresets = [
  {
    aliases: ["Cascadia Mono", "Cascadia Code"],
    family: "\"Cascadia Mono\", \"Cascadia Code\", Consolas, monospace",
    label: "Cascadia Mono",
  },
  {
    aliases: ["JetBrains Mono"],
    family: "\"JetBrains Mono\", \"Cascadia Mono\", Consolas, monospace",
    label: "JetBrains Mono",
  },
  {
    aliases: ["Fira Code"],
    family: "\"Fira Code\", \"Cascadia Mono\", Consolas, monospace",
    label: "Fira Code",
  },
  {
    aliases: ["Iosevka"],
    family: "\"Iosevka\", \"Cascadia Mono\", Consolas, monospace",
    label: "Iosevka",
  },
  {
    aliases: ["Source Code Pro"],
    family: "\"Source Code Pro\", \"Cascadia Mono\", Consolas, monospace",
    label: "Source Code Pro",
  },
  {
    aliases: ["IBM Plex Mono"],
    family: "\"IBM Plex Mono\", \"Cascadia Mono\", Consolas, monospace",
    label: "IBM Plex Mono",
  },
  {
    aliases: ["Roboto Mono"],
    family: "\"Roboto Mono\", \"Cascadia Mono\", Consolas, monospace",
    label: "Roboto Mono",
  },
  {
    aliases: ["Hack"],
    family: "\"Hack\", \"Cascadia Mono\", Consolas, monospace",
    label: "Hack",
  },
];

export function ThemeSettings({ onSaveSettings, settings }: ThemeSettingsProps) {
  const updateTheme = (theme: Partial<AppSettings["theme"]>) =>
    onSaveSettings({ ...settings, theme: { ...settings.theme, ...theme } });
  const selectedFontPreset =
    terminalFontPresets.find(
      (preset) =>
        preset.family === settings.theme.terminalFontFamily ||
        preset.aliases.includes(settings.theme.terminalFontFamily),
    ) ?? null;
  const modeLabels: Record<AppSettings["theme"]["mode"], string> = {
    dark: "深色",
    light: "浅色",
    system: "跟随系统",
  };
  const modeIcons: Record<AppSettings["theme"]["mode"], IconName> = {
    dark: "moon",
    light: "sun",
    system: "monitor",
  };

  return (
    <section className="settings-block appearance-settings-block">
      <SettingsSectionHeader title="主题" />
      <SegmentedControl
        aria-label="主题模式"
        className="segmented-control"
        options={(["dark", "light", "system"] as const).map((mode) => ({
          ariaLabel: modeLabels[mode],
          icon: modeIcons[mode],
          label: modeLabels[mode],
          title: modeLabels[mode],
          value: mode,
        }))}
        value={settings.theme.mode}
        onChange={(mode) => updateTheme({ mode })}
      />
      <div className="settings-field-grid">
        <label className="settings-field">
          <span>字体预设</span>
          <Select
            value={selectedFontPreset?.family ?? customFontValue}
            options={[
              ...terminalFontPresets.map((preset) => ({
                label: preset.label,
                value: preset.family,
              })),
              ...(!selectedFontPreset ? [{ label: "自定义", value: customFontValue }] : []),
            ]}
            onChange={(value) => {
              if (value !== customFontValue) {
                updateTheme({ terminalFontFamily: value });
              }
            }}
          />
        </label>
        <label className="settings-field compact">
          <span>字号</span>
          <TextInput
            min="8"
            max="32"
            type="number"
            value={settings.theme.terminalFontSize}
            onChange={(event) => updateTheme({ terminalFontSize: Number(event.currentTarget.value) })}
          />
        </label>
      </div>
      <label className="settings-field">
        <span>自定义字体栈</span>
        <TextInput
          mono
          value={settings.theme.terminalFontFamily}
          onChange={(event) => updateTheme({ terminalFontFamily: event.currentTarget.value })}
        />
      </label>
      <div className="terminal-font-preview" style={{ fontFamily: settings.theme.terminalFontFamily }}>
        <span>root@portiva:~$ pnpm build && ssh 192.168.1.1</span>
        <span>ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789</span>
        <span>这是一段测试文本</span>
      </div>
    </section>
  );
}
