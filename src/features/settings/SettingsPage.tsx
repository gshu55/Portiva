import { useState } from "react";
import { ApplicationSettings } from "./ApplicationSettings";
import { SettingsPanel, type SettingsSectionId } from "./SettingsPanel";
import type { IconName } from "../../shared/Icon";
import { Button } from "../../shared/ui";
import type {
  AppSettings,
  KnownHostEntry,
  SecretMetadata,
} from "../../shared/types";

type ApplicationMenuId = "about";
type SettingsMenuId = SettingsSectionId | ApplicationMenuId;
const menuItems: Array<{ id: SettingsMenuId; icon: IconName; label: string; description: string }> = [
  { id: "theme", icon: "palette", label: "外观", description: "主题、背景和字体" },
  { id: "terminal-palette", icon: "palette", label: "终端配色", description: "ANSI 色板和预设" },
  { id: "terminal", icon: "terminal", label: "终端", description: "鼠标和输入行为" },
  { id: "network", icon: "network", label: "网络", description: "全局代理和连接策略" },
  { id: "keymap", icon: "keyboard", label: "快捷键", description: "全局操作键位" },
  { id: "security", icon: "shield", label: "安全", description: "主机密钥、脱敏和凭据元数据" },
  { id: "about", icon: "file-text", label: "关于", description: "产品信息和法律声明" },
];

interface SettingsPageProps {
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

export function SettingsPage({
  knownHosts,
  onDeleteKnownHost,
  onDeleteSecretMetadata,
  onPreviewRedaction,
  onRedactionInputChange,
  onSaveSettings,
  redactionInput,
  redactionPreview,
  secrets,
  settings,
}: SettingsPageProps) {
  const [activeMenu, setActiveMenu] = useState<SettingsMenuId>("theme");

  return (
    <section className="settings-page">
      <div className="settings-layout">
        <nav className="settings-menu" aria-label="设置菜单">
          {menuItems.map((item) => (
            <Button
              active={activeMenu === item.id}
              aria-label={`${item.label}：${item.description}`}
              data-description={item.description}
              data-label={item.label}
              icon={item.icon}
              key={item.id}
              onClick={() => setActiveMenu(item.id)}
              tone="muted"
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </Button>
          ))}
        </nav>
        <div className="settings-content">
          {activeMenu === "about" ? (
            <ApplicationSettings />
          ) : (
            <SettingsPanel
              section={activeMenu}
              knownHosts={knownHosts}
              redactionInput={redactionInput}
              redactionPreview={redactionPreview}
              secrets={secrets}
              settings={settings}
              onDeleteKnownHost={onDeleteKnownHost}
              onDeleteSecretMetadata={onDeleteSecretMetadata}
              onPreviewRedaction={onPreviewRedaction}
              onRedactionInputChange={onRedactionInputChange}
              onSaveSettings={onSaveSettings}
            />
          )}
        </div>
      </div>
    </section>
  );
}
