import { CapabilityPanel } from "../connections/CapabilityPanel";
import { SettingsSectionHeader } from "./SettingsSection";
import type { ConnectionCapabilities } from "../../shared/types";

interface ApplicationSettingsProps {
  capabilities: ConnectionCapabilities;
}

export function ApplicationSettings({ capabilities }: ApplicationSettingsProps) {
  return (
    <section className="settings-panel application-settings">
      <SettingsSectionHeader description="应用信息、隐私说明和当前会话能力。" title="应用" />
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="Portiva 终端和连接管理工作台。" title="关于" />
        <div className="application-info-grid">
          <span>应用</span>
          <strong>Portiva</strong>
          <span>运行环境</span>
          <strong>本机桌面应用</strong>
        </div>
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="隐私相关数据默认保留在本机。" title="隐私" />
        <div className="application-privacy-list">
          <span>连接配置、主机密钥和凭据元数据存放在本机工作区。</span>
          <span>终端内容、日志和诊断信息不会自动上传到远程服务。</span>
          <span>剪贴板、文件传输和终端输入只在你主动操作时使用。</span>
        </div>
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="当前活动连接支持的功能。" title="能力" />
        <CapabilityPanel capabilities={capabilities} />
      </section>
    </section>
  );
}
