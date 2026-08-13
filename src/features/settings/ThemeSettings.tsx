import { useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { appBackgroundPresets, defaultAppBackground } from "../../shared/appBackgrounds";
import { prepareBackgroundImage } from "../../shared/backgroundImage";
import type { AppBackgroundPresetId, AppSettings } from "../../shared/types";
import type { IconName } from "../../shared/Icon";
import { SegmentedControl, Toggle } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface ThemeSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

export function ThemeSettings({ onSaveSettings, settings }: ThemeSettingsProps) {
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);
  const [backgroundError, setBackgroundError] = useState("");
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const background = settings.theme.background ?? defaultAppBackground;
  const updateTheme = (theme: Partial<AppSettings["theme"]>) =>
    onSaveSettings({ ...settings, theme: { ...settings.theme, ...theme } });
  const updateBackground = (value: Partial<AppSettings["theme"]["background"]>) =>
    updateTheme({ background: { ...background, ...value } });
  const selectBackgroundPreset = (preset: AppBackgroundPresetId) => {
    if (preset === "custom") {
      setBackgroundError("");
      backgroundFileInputRef.current?.click();
      return;
    }

    updateBackground({ enabled: true, preset });
  };
  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setBackgroundError("");

    if (!file) {
      return;
    }

    setBackgroundLoading(true);
    try {
      const prepared = await prepareBackgroundImage(file);
      updateBackground({ customImage: prepared.dataUrl, enabled: true, preset: "custom" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "图片处理失败";
      setBackgroundError(`${message}，请重新选择。`);
    } finally {
      setBackgroundLoading(false);
    }
  };
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
        <SettingsSectionHeader title="主题" />
        <SegmentedControl
          aria-label="主题模式"
          className={`segmented-control theme-mode-control mode-${settings.theme.mode}`}
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
      </section>

      <section className="settings-block background-settings-block">
        <SettingsSectionHeader
          title="全局背景"
        />
        <Toggle
          checked={background.enabled}
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
              <span>透明度</span>
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
        </div>
      </section>
    </>
  );
}
