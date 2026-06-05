import type { AppSettings, TerminalRightClickBehavior } from "../../shared/types";
import { Button, Toggle } from "../../shared/ui";
import { SettingsSectionHeader } from "./SettingsSection";

interface TerminalSettingsProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

const rightClickOptions: Array<{
  description: string;
  label: string;
  value: TerminalRightClickBehavior;
}> = [
  {
    value: "disabled",
    label: "关闭",
    description: "右键不触发终端操作。",
  },
  {
    value: "context-menu",
    label: "右键菜单",
    description: "打开复制、粘贴和搜索菜单。",
  },
  {
    value: "paste",
    label: "粘贴",
    description: "右键直接粘贴剪贴板内容。",
  },
  {
    value: "copy-or-paste",
    label: "智能复制/粘贴",
    description: "选中文本时复制，未选择内容时粘贴。",
  },
];

export function TerminalSettings({ onSaveSettings, settings }: TerminalSettingsProps) {
  const updateTerminal = (terminal: Partial<AppSettings["terminal"]>) =>
    onSaveSettings({ ...settings, terminal: { ...settings.terminal, ...terminal } });

  return (
    <>
      <section className="settings-block terminal-behavior-settings-block">
        <SettingsSectionHeader
          description="配置终端输入区的鼠标交互。"
          title="鼠标"
        />
        <div className="terminal-right-click-options" aria-label="终端右键点击功能">
          {rightClickOptions.map((option) => (
            <Button
              active={settings.terminal.rightClickBehavior === option.value}
              aria-pressed={settings.terminal.rightClickBehavior === option.value}
              key={option.value}
              onClick={() => updateTerminal({ rightClickBehavior: option.value })}
              tone="muted"
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </Button>
          ))}
        </div>
      </section>

      <section className="settings-block terminal-behavior-settings-block">
        <SettingsSectionHeader
          description="粘贴多行命令前先进入可编辑确认。"
          title="粘贴"
        />
        <div className="settings-toggle-grid">
          <Toggle
            checked={settings.terminal.confirmMultilinePaste}
            label="多行粘贴前编辑并确认"
            onChange={(event) => updateTerminal({ confirmMultilinePaste: event.currentTarget.checked })}
          />
        </div>
      </section>

      <section className="settings-block terminal-behavior-settings-block">
        <SettingsSectionHeader
          description="控制终端复制时是否写入 HTML 富文本格式。"
          title="复制"
        />
        <div className="settings-toggle-grid">
          <Toggle
            checked={settings.terminal.copyRichText}
            label="复制时保留终端颜色格式"
            onChange={(event) => updateTerminal({ copyRichText: event.currentTarget.checked })}
          />
        </div>
      </section>
    </>
  );
}
