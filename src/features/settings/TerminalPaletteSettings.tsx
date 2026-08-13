import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, TerminalColorPresetId } from "../../shared/types";
import type { IconName } from "../../shared/Icon";
import { systemFontsList } from "../../shared/ipc/commands";
import {
  resolveTerminalPalette,
  terminalColorPresets,
  type TerminalColorKey,
} from "../../shared/terminalThemes";
import {
  bundledTerminalFontFamily,
  isSystemTerminalFontAvailable,
  registerAvailableSystemTerminalFonts,
  resolveTerminalFontFamily,
  resolveTerminalFontSize,
  systemTerminalFontPresets,
} from "../../shared/terminalFonts";
import { ColorPicker, SegmentedControl, Select, TextInput } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface TerminalPaletteSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

const terminalPaletteModeOptions: Array<{
  icon: IconName;
  label: string;
  value: TerminalColorPresetId;
}> = [
  { icon: "moon", label: "深色", value: "dark" },
  { icon: "sun", label: "浅色", value: "light" },
  { icon: "palette", label: "自定义", value: "custom" },
];
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
  const [systemFontFamilies, setSystemFontFamilies] = useState<string[]>(() =>
    systemTerminalFontPresets
      .filter((preset) => isSystemTerminalFontAvailable(preset.family))
      .map((preset) => preset.family),
  );
  const refreshSystemFonts = useCallback(async () => {
    try {
      const fontFamilies = await systemFontsList();
      if (fontFamilies.length > 0) {
        registerAvailableSystemTerminalFonts(fontFamilies);
        setSystemFontFamilies(fontFamilies);
      }
    } catch {
      // Browser preview mode has no native font enumeration command.
    }
  }, []);

  useEffect(() => {
    void refreshSystemFonts();
    window.addEventListener("focus", refreshSystemFonts);
    return () => window.removeEventListener("focus", refreshSystemFonts);
  }, [refreshSystemFonts]);

  const updateTheme = (theme: Partial<AppSettings["theme"]>) =>
    onSaveSettings({ ...settings, theme: { ...settings.theme, ...theme } });
  const terminalPalette = resolveTerminalPalette(settings.theme);
  const terminalFontPresets = useMemo(
    () => [
      { family: bundledTerminalFontFamily, label: "JetBrains Mono" },
      ...systemFontFamilies
        .filter(
          (family) =>
            family.toLocaleLowerCase() !== "jetbrains mono" &&
            family.toLocaleLowerCase() !== bundledTerminalFontFamily.toLocaleLowerCase(),
        )
        .map((family) => ({ family, label: family })),
    ],
    [systemFontFamilies],
  );
  const selectedFontPreset =
    terminalFontPresets.find((preset) => preset.family === settings.theme.terminalFontFamily) ??
    terminalFontPresets[0];
  const terminalFontFamily = resolveTerminalFontFamily(settings.theme.terminalFontFamily);
  const terminalFontSize = resolveTerminalFontSize(settings.theme.terminalFontSize);
  const updateTerminalPreset = (presetId: "dark" | "light") => {
    updateTheme({
      terminalColorPreset: presetId,
      terminalColors: terminalColorPresets[presetId].colors,
    });
  };
  const updateTerminalPaletteMode = (presetId: TerminalColorPresetId) => {
    if (presetId === "custom") {
      updateTheme({
        terminalColorPreset: "custom",
        terminalColors: terminalPalette,
      });
      return;
    }

    updateTerminalPreset(presetId);
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
      <SettingsSectionHeader title="字体与配色" />
      <div className="settings-field-grid">
        <label className="settings-field">
          <span>字体</span>
          <Select
            value={selectedFontPreset.family}
            options={terminalFontPresets.map((preset) => ({
              label: (
                <span
                  className="terminal-font-option-preview"
                  style={{ fontFamily: resolveTerminalFontFamily(preset.family) }}
                >
                  {preset.label}
                </span>
              ),
              value: preset.family,
            }))}
            onFocus={() => void refreshSystemFonts()}
            onChange={(terminalFontFamily) => updateTheme({ terminalFontFamily })}
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
      <SegmentedControl<TerminalColorPresetId>
        aria-label="终端配色预设"
        className={`segmented-control theme-mode-control terminal-palette-mode-control mode-${settings.theme.terminalColorPreset}`}
        options={terminalPaletteModeOptions.map((option) => ({
          ariaLabel: option.label,
          icon: option.icon,
          label: option.label,
          title: option.label,
          value: option.value,
        }))}
        value={settings.theme.terminalColorPreset}
        onChange={updateTerminalPaletteMode}
      />
      <div
        className="terminal-palette-preview"
        key={`${terminalFontFamily}:${terminalFontSize}`}
        style={{
          background: terminalPalette.background,
          borderColor: terminalPalette.selectionBackground,
          color: terminalPalette.foreground,
          fontFamily: terminalFontFamily,
          fontSize: `${terminalFontSize}px`,
        }}
      >
        <span>
          <b style={{ color: terminalPalette.green }}>deploy</b>
          <span style={{ color: terminalPalette.foreground }}>@</span>
          <b style={{ color: terminalPalette.blue }}>prod-web</b>
          <span style={{ color: terminalPalette.foreground }}>:~$ ssh root@10.0.0.8</span>
        </span>
        <span style={{ color: terminalPalette.yellow }}>warning: config changed, reload pending</span>
        <span>
          <b style={{ color: terminalPalette.cyan }}>200 OK</b>
          <span style={{ color: terminalPalette.foreground }}> · 0 O o · 1 I l | · Aa Gg Qq Mm Ww · 中文</span>
        </span>
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
                  <div className="terminal-color-field" key={field.key}>
                    <span>{field.label}</span>
                    <ColorPicker
                      aria-label={`${field.label}颜色选择器`}
                      title={`选择${field.label}颜色`}
                      value={value}
                      onChange={(event) => updateTerminalColor(field.key, event.currentTarget.value)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
