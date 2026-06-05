import type { AppSettings } from "../../shared/types";
import { Icon, type IconName } from "../../shared/Icon";
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
      <div className="segmented-control" aria-label="主题模式">
        {(["dark", "light", "system"] as const).map((mode) => (
          <button
            aria-label={modeLabels[mode]}
            className={settings.theme.mode === mode ? "active" : ""}
            key={mode}
            onClick={() => updateTheme({ mode })}
            title={modeLabels[mode]}
            type="button"
          >
            <Icon name={modeIcons[mode]} />
          </button>
        ))}
      </div>
      <div className="settings-field-grid">
        <label className="settings-field">
          <span>字体预设</span>
          <select
            value={selectedFontPreset?.family ?? customFontValue}
            onChange={(event) => {
              if (event.currentTarget.value !== customFontValue) {
                updateTheme({ terminalFontFamily: event.currentTarget.value });
              }
            }}
          >
            {terminalFontPresets.map((preset) => (
              <option key={preset.family} value={preset.family}>
                {preset.label}
              </option>
            ))}
            {!selectedFontPreset ? <option value={customFontValue}>自定义</option> : null}
          </select>
        </label>
        <label className="settings-field compact">
          <span>字号</span>
          <input
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
        <input
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
