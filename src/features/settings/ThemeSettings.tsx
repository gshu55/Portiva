import { useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { appBackgroundPresets, defaultAppBackground } from "../../shared/appBackgrounds";
import { formatImageBytes, prepareBackgroundImage } from "../../shared/backgroundImage";
import type { AppBackgroundPresetId, AppSettings } from "../../shared/types";
import type { IconName } from "../../shared/Icon";
import { SegmentedControl, Select, TextInput, Toggle } from "../../shared/ui";
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
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);
  const [backgroundError, setBackgroundError] = useState("");
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [backgroundStatus, setBackgroundStatus] = useState("");
  const background = settings.theme.background ?? defaultAppBackground;
  const updateTheme = (theme: Partial<AppSettings["theme"]>) =>
    onSaveSettings({ ...settings, theme: { ...settings.theme, ...theme } });
  const updateBackground = (value: Partial<AppSettings["theme"]["background"]>) =>
    updateTheme({ background: { ...background, ...value } });
  const selectBackgroundPreset = (preset: AppBackgroundPresetId) => {
    if (preset === "custom") {
      setBackgroundError("");
      setBackgroundStatus("");
      backgroundFileInputRef.current?.click();
      return;
    }

    updateBackground({ enabled: true, preset });
  };
  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setBackgroundError("");
    setBackgroundStatus("");

    if (!file) {
      return;
    }

    setBackgroundLoading(true);
    try {
      const prepared = await prepareBackgroundImage(file);
      updateBackground({ customImage: prepared.dataUrl, enabled: true, preset: "custom" });
      setBackgroundStatus(
        `已应用 ${prepared.width}×${prepared.height} 背景（${formatImageBytes(prepared.sourceBytes)} → ${formatImageBytes(prepared.storedBytes)}）。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "图片处理失败";
      setBackgroundError(`${message}，请重新选择。`);
    } finally {
      setBackgroundLoading(false);
    }
  };
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
    <>
      <section className="settings-block appearance-settings-block">
        <SettingsSectionHeader title="主题与字体" />
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

      <section className="settings-block background-settings-block">
        <SettingsSectionHeader
          description="应用到主窗口、SSH、SFTP、主机概览和运维工作台。"
          title="全局背景"
        />
        <Toggle
          checked={background.enabled}
          description="关闭后保留当前选择，下次开启可直接恢复。"
          label="显示背景图"
          onChange={(event) => updateBackground({ enabled: event.currentTarget.checked })}
        />
        <div className="background-settings-content" aria-disabled={!background.enabled}>
          <div className="background-preset-grid" role="radiogroup" aria-label="背景图预设">
            {appBackgroundPresets.map((preset) => (
              <button
                aria-checked={background.preset === preset.id}
                className={background.preset === preset.id ? "active" : ""}
                key={preset.id}
                onClick={() => selectBackgroundPreset(preset.id)}
                role="radio"
                style={{ "--background-preview-image": preset.image } as CSSProperties}
                type="button"
              >
                <span className="background-preset-preview" />
                <strong>{preset.label}</strong>
                <small>{preset.description}</small>
              </button>
            ))}
            <button
              aria-label={
                background.customImage
                  ? "自定义背景，点击选择新图片替换当前图片"
                  : "自定义背景，点击选择本地图片"
              }
              aria-checked={background.preset === "custom"}
              aria-busy={backgroundLoading}
              className={background.preset === "custom" ? "active" : ""}
              disabled={backgroundLoading}
              onClick={() => selectBackgroundPreset("custom")}
              role="radio"
              style={{
                "--background-preview-image": background.customImage
                  ? `url("${background.customImage}")`
                  : "linear-gradient(135deg, #18252d, #35586a)",
              } as CSSProperties}
              title={background.customImage ? "选择新图片并替换当前背景" : "选择本地背景图片"}
              type="button"
            >
              <span
                className={`background-preset-preview background-custom-preview${background.customImage ? " has-image" : ""}`}
              />
              <strong>自定义</strong>
              <small>
                {backgroundLoading
                  ? "正在处理…"
                  : background.customImage
                    ? "点击替换"
                    : "点击选择"}
              </small>
            </button>
          </div>
          <input
            accept="image/*"
            className="background-file-input"
            onChange={uploadBackground}
            ref={backgroundFileInputRef}
            type="file"
          />
          <div className="background-adjustments">
            <label>
              <span>显示强度</span>
              <input
                aria-label="背景显示强度"
                max="100"
                min="0"
                type="range"
                value={background.opacity}
                onChange={(event) => updateBackground({ opacity: Number(event.currentTarget.value) })}
              />
              <output>{background.opacity}%</output>
            </label>
            <label>
              <span>模糊</span>
              <input
                aria-label="背景模糊"
                max="24"
                min="0"
                type="range"
                value={background.blur}
                onChange={(event) => updateBackground({ blur: Number(event.currentTarget.value) })}
              />
              <output>{background.blur}px</output>
            </label>
          </div>
          {backgroundError ? (
            <p className="background-settings-error" role="alert">{backgroundError}</p>
          ) : null}
          {backgroundStatus ? (
            <p aria-live="polite" className="background-settings-status" role="status">
              {backgroundStatus}
            </p>
          ) : null}
          <p className="background-settings-note">
            显示强度仅控制背景可见度和表面透明度；模糊为独立的 0–24px，设为 0px 时保持原图清晰。源图片不限文件大小，导入时会在本机解码并优化后保存。
          </p>
        </div>
      </section>
    </>
  );
}
