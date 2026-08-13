import type { AppSettings } from "../../shared/types";
import { TextInput } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface KeymapSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

const shortcutFields: Array<[keyof AppSettings["keymap"], string]> = [
  ["newProfile", "新建连接"],
  ["openHostOverview", "打开主机概览"],
  ["openLocalTerminal", "打开本地终端"],
  ["openSerialTerminal", "打开串口终端"],
  ["openSettings", "打开设置"],
  ["increaseFontSize", "放大"],
  ["decreaseFontSize", "缩小"],
  ["closeTab", "关闭标签"],
];

export function KeymapSettings({ onSaveSettings, settings }: KeymapSettingsProps) {
  const updateKeymap = (key: keyof AppSettings["keymap"], value: string) =>
    onSaveSettings({ ...settings, keymap: { ...settings.keymap, [key]: value } });

  return (
    <section className="settings-block">
      <SettingsSectionHeader title="快捷键" />
      <div className="shortcut-list">
        {shortcutFields.map(([key, label]) => (
          <label className="shortcut-row" key={key}>
            <span>{label}</span>
            <TextInput mono value={settings.keymap[key] ?? ""} onChange={(event) => updateKeymap(key, event.currentTarget.value)} />
          </label>
        ))}
      </div>
    </section>
  );
}
