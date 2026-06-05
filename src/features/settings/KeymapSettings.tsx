import type { AppSettings } from "../../shared/types";
import { SettingsSectionHeader } from "./SettingsSection";

interface KeymapSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

const shortcutFields: Array<[keyof AppSettings["keymap"], string]> = [
  ["newProfile", "新建连接"],
  ["openLocalTerminal", "打开本地终端"],
  ["openSerialTerminal", "打开串口终端"],
  ["closeTab", "关闭标签"],
];

export function KeymapSettings({ onSaveSettings, settings }: KeymapSettingsProps) {
  const updateKeymap = (key: keyof AppSettings["keymap"], value: string) =>
    onSaveSettings({ ...settings, keymap: { ...settings.keymap, [key]: value } });

  return (
    <section className="settings-block">
      <SettingsSectionHeader description="常用工作区操作的键位。" title="快捷键" />
      <div className="shortcut-list">
        {shortcutFields.map(([key, label]) => (
          <label className="shortcut-row" key={key}>
            <span>{label}</span>
            <input value={settings.keymap[key] ?? ""} onChange={(event) => updateKeymap(key, event.currentTarget.value)} />
          </label>
        ))}
      </div>
    </section>
  );
}
