import { KeymapSettings } from "./KeymapSettings";
import { SecuritySettings } from "./SecuritySettings";
import { SettingsSectionHeader } from "./SettingsSection";
import { TerminalPaletteSettings } from "./TerminalPaletteSettings";
import { TerminalSettings } from "./TerminalSettings";
import { ThemeSettings } from "./ThemeSettings";
import type { AppSettings, KnownHostEntry, SecretMetadata } from "../../shared/types";

export type SettingsSectionId = "theme" | "terminal-palette" | "terminal" | "keymap" | "security";

interface SettingsPanelProps {
  section: SettingsSectionId;
  knownHosts: KnownHostEntry[];
  redactionInput: string;
  redactionPreview: string;
  secrets: SecretMetadata[];
  settings: AppSettings;
  onDeleteSecretMetadata: (secretId: string) => void;
  onDeleteKnownHost: (host: string) => void;
  onPreviewRedaction: () => void;
  onRedactionInputChange: (value: string) => void;
  onSaveSettings: (settings: AppSettings) => void;
}

const sectionMeta: Record<SettingsSectionId, { description: string; title: string }> = {
  keymap: {
    description: "管理会话级操作快捷键。",
    title: "快捷键",
  },
  security: {
    description: "管理主机信任、日志脱敏和凭据元数据。",
    title: "安全",
  },
  terminal: {
    description: "管理终端交互和输入行为。",
    title: "终端",
  },
  "terminal-palette": {
    description: "管理终端颜色预设和 ANSI 色板。",
    title: "终端配色",
  },
  theme: {
    description: "调整工作区主题、终端字体和字号。",
    title: "外观",
  },
};

export function SettingsPanel({
  knownHosts,
  onPreviewRedaction,
  onDeleteSecretMetadata,
  onDeleteKnownHost,
  onRedactionInputChange,
  onSaveSettings,
  redactionInput,
  redactionPreview,
  section,
  secrets,
  settings,
}: SettingsPanelProps) {
  const meta = sectionMeta[section];

  return (
    <section className="panel settings-panel">
      <SettingsSectionHeader description={meta.description} title={meta.title} />
      {section === "theme" ? <ThemeSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "terminal-palette" ? <TerminalPaletteSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "terminal" ? <TerminalSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "keymap" ? <KeymapSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "security" ? (
        <SecuritySettings
          knownHosts={knownHosts}
          redactionInput={redactionInput}
          redactionPreview={redactionPreview}
          secrets={secrets}
          settings={settings}
          onDeleteSecretMetadata={onDeleteSecretMetadata}
          onDeleteKnownHost={onDeleteKnownHost}
          onPreviewRedaction={onPreviewRedaction}
          onRedactionInputChange={onRedactionInputChange}
          onSaveSettings={onSaveSettings}
        />
      ) : null}
    </section>
  );
}
