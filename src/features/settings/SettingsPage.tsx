import { useState } from "react";
import { ApplicationSettings } from "./ApplicationSettings";
import { SettingsPanel, type SettingsSectionId } from "./SettingsPanel";
import type { IconName } from "../../shared/Icon";
import { Button } from "../../shared/ui";
import type { AppSettings } from "../../shared/types";
import type { AppUpdateController } from "../../app/useAppUpdate";

type ApplicationMenuId = "about";
type SettingsMenuId = SettingsSectionId | ApplicationMenuId;
const menuItems: Array<{ id: SettingsMenuId; icon: IconName; label: string; description: string }> = [
  { id: "theme", icon: "palette", label: "外观", description: "主题和全局背景" },
  { id: "terminal", icon: "terminal", label: "终端", description: "字体、配色和输入" },
  { id: "network", icon: "network", label: "网络", description: "代理和安全提示" },
  { id: "keymap", icon: "keyboard", label: "快捷键", description: "全局操作键位" },
  { id: "about", icon: "file-text", label: "关于", description: "产品信息和法律声明" },
];

interface SettingsPageProps {
  appUpdate: AppUpdateController;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

export function SettingsPage({
  appUpdate,
  onSaveSettings,
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
              data-label={item.label}
              icon={item.icon}
              key={item.id}
              onClick={() => setActiveMenu(item.id)}
              tone="muted"
            >
              <span>{item.label}</span>
            </Button>
          ))}
        </nav>
        <div className="settings-content">
          {activeMenu === "about" ? (
            <ApplicationSettings appUpdate={appUpdate} />
          ) : (
            <SettingsPanel
              section={activeMenu}
              settings={settings}
              onSaveSettings={onSaveSettings}
            />
          )}
        </div>
      </div>
    </section>
  );
}
