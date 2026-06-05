import { useState } from "react";
import { ApplicationSettings } from "./ApplicationSettings";
import { SettingsPanel, type SettingsSectionId } from "./SettingsPanel";
import { SettingsSectionHeader } from "./SettingsSection";
import { DiagnosticsLogs } from "./diagnostics/DiagnosticsLogs";
import { DiagnosticsOverview } from "./diagnostics/DiagnosticsOverview";
import { DiagnosticsProtocols } from "./diagnostics/DiagnosticsProtocols";
import { DiagnosticsStatus } from "./diagnostics/DiagnosticsStatus";
import { DiagnosticsTunnels } from "./diagnostics/DiagnosticsTunnels";
import { Icon } from "../../shared/Icon";
import type { IconName } from "../../shared/Icon";
import type {
  AppSettings,
  ConnectionCapabilities,
  ConnectionSummary,
  ProfileGroup,
  KnownHostEntry,
  LogEntry,
  ProtocolDescriptor,
  RecentConnection,
  SecretMetadata,
  TunnelRule,
} from "../../shared/types";

type DiagnosticsMenuId =
  | "diagnostics-overview"
  | "diagnostics-protocols"
  | "diagnostics-tunnels"
  | "diagnostics-status"
  | "diagnostics-logs";
type ApplicationMenuId = "application";
type SettingsMenuId = SettingsSectionId | ApplicationMenuId | DiagnosticsMenuId;
const menuItems: Array<{ id: SettingsMenuId; icon: IconName; label: string; description: string }> = [
  { id: "application", icon: "settings", label: "应用", description: "关于、隐私和能力" },
  { id: "theme", icon: "palette", label: "外观", description: "主题和字体" },
  { id: "terminal-palette", icon: "palette", label: "终端配色", description: "ANSI 色板和预设" },
  { id: "terminal", icon: "terminal", label: "终端", description: "鼠标和输入行为" },
  { id: "keymap", icon: "keyboard", label: "快捷键", description: "全局操作键位" },
  { id: "security", icon: "shield", label: "安全", description: "主机密钥、脱敏和凭据元数据" },
  { id: "diagnostics-overview", icon: "activity", label: "诊断概览", description: "连接入口" },
  { id: "diagnostics-protocols", icon: "plug", label: "协议诊断", description: "注册表和能力矩阵" },
  { id: "diagnostics-tunnels", icon: "network", label: "隧道诊断", description: "端口转发规则" },
  { id: "diagnostics-status", icon: "monitor", label: "状态诊断", description: "当前连接状态" },
  { id: "diagnostics-logs", icon: "terminal", label: "日志诊断", description: "事件记录" },
];

interface SettingsPageProps {
  capabilities: ConnectionCapabilities;
  connection: ConnectionSummary | null;
  groups: ProfileGroup[];
  knownHosts: KnownHostEntry[];
  logs: LogEntry[];
  message: string;
  protocolDescriptors: ProtocolDescriptor[];
  recentConnections: RecentConnection[];
  redactionInput: string;
  redactionPreview: string;
  secrets: SecretMetadata[];
  settings: AppSettings;
  tunnels: TunnelRule[];
  onClearLogs: () => void;
  onDeleteSecretMetadata: (secretId: string) => void;
  onDeleteKnownHost: (host: string) => void;
  onPreviewRedaction: () => void;
  onRedactionInputChange: (value: string) => void;
  onSaveSettings: (settings: AppSettings) => void;
}

export function SettingsPage({
  capabilities,
  connection,
  groups,
  knownHosts,
  onClearLogs,
  onDeleteKnownHost,
  onDeleteSecretMetadata,
  onPreviewRedaction,
  onRedactionInputChange,
  onSaveSettings,
  logs,
  message,
  protocolDescriptors,
  recentConnections,
  redactionInput,
  redactionPreview,
  secrets,
  settings,
  tunnels,
}: SettingsPageProps) {
  const [activeMenu, setActiveMenu] = useState<SettingsMenuId>("theme");

  const renderDiagnosticsContent = () => {
    if (activeMenu === "diagnostics-overview") {
      return (
        <section className="settings-panel settings-diagnostics settings-diagnostics-overview">
          <SettingsSectionHeader description="连接入口和最近连接。" title="诊断概览" />
          <DiagnosticsOverview groups={groups} recentConnections={recentConnections} />
        </section>
      );
    }

    if (activeMenu === "diagnostics-protocols") {
      return (
        <section className="settings-panel settings-diagnostics">
          <SettingsSectionHeader description="协议注册状态和能力矩阵。" title="协议诊断" />
          <DiagnosticsProtocols protocols={protocolDescriptors} />
        </section>
      );
    }

    if (activeMenu === "diagnostics-tunnels") {
      return (
        <section className="settings-panel settings-diagnostics">
          <SettingsSectionHeader description="端口转发和隧道规则。" title="隧道诊断" />
          <DiagnosticsTunnels capabilities={capabilities} tunnels={tunnels} />
        </section>
      );
    }

    if (activeMenu === "diagnostics-logs") {
      return (
        <section className="settings-panel settings-diagnostics settings-diagnostics-logs">
          <SettingsSectionHeader description="当前会话的事件日志记录。" title="日志诊断" />
          <DiagnosticsLogs logs={logs} onClearLogs={onClearLogs} />
        </section>
      );
    }

    if (activeMenu === "diagnostics-status") {
      return (
        <section className="settings-panel settings-diagnostics">
          <SettingsSectionHeader description="当前连接状态、工作区提示和日志数量。" title="状态诊断" />
          <DiagnosticsStatus connection={connection} logs={logs} message={message} />
        </section>
      );
    }

    return null;
  };

  return (
    <section className="settings-page">
      <div className="settings-layout">
        <nav className="settings-menu" aria-label="设置菜单">
          {menuItems.map((item) => (
            <button
              aria-label={`${item.label}：${item.description}`}
              className={activeMenu === item.id ? "active" : ""}
              data-description={item.description}
              data-label={item.label}
              key={item.id}
              onClick={() => setActiveMenu(item.id)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {activeMenu === "application" ? (
            <ApplicationSettings capabilities={capabilities} />
          ) : activeMenu === "theme" || activeMenu === "terminal-palette" || activeMenu === "terminal" || activeMenu === "keymap" || activeMenu === "security" ? (
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
          ) : (
            renderDiagnosticsContent()
          )}
        </div>
      </div>
    </section>
  );
}
