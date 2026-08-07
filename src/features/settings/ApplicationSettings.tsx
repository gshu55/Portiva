import { useAppMetadata } from "../../shared/useAppMetadata";
import { SettingsSectionHeader } from "./SettingsSection";

const privacyItems = [
  "连接配置、工作区设置、已知主机记录和凭据元数据默认保存在本机。",
  "终端内容、HTTP 请求数据、文件传输路径和日志不会由 Portiva 自动上传到任何远程服务。",
  "剪贴板、文件系统、网络连接和密钥访问只会在你主动执行相关操作时使用。",
  "敏感字段可能会在本地日志中脱敏显示，但你仍应避免在共享屏幕或导出的日志中暴露私密信息。",
];

const termsItems = [
  "继续访问、启动或使用 Portiva，即表示你已阅读、理解并同意本页隐私声明、条款声明和安全说明；如果你不同意相关内容，应停止使用本软件。",
  "你应仅连接自己拥有、管理或已获授权访问的主机、设备和网络服务。",
  "你需要自行确认连接目标、传输内容、命令执行和文件操作符合所在组织及当地法律法规要求。",
  "Telnet、Raw TCP、FTP 等非加密协议可能以明文传输数据，建议只在可信网络或实验环境中使用。",
  "本软件按现状提供；使用过程中产生的数据丢失、服务中断或远端操作后果由操作者自行评估和承担。",
];

const securityItems = [
  "SSH/SFTP 密码和私钥口令使用系统安全存储；HTTP 请求认证字段按当前产品约定随本地请求草稿明文保存。",
  "SSH 主机密钥变更会被视为高风险事件，确认前不应继续连接。",
  "本机配置、日志和导出文件由当前操作系统账户保护，请妥善管理设备访问权限。",
];

export function ApplicationSettings() {
  const { error, loading, metadata } = useAppMetadata();
  const pendingLabel = loading ? "正在读取…" : "不可用";

  return (
    <section className="settings-panel application-settings">
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="面向本机工作流的多协议终端和连接管理工具。" title="产品信息" />
        <div className="application-info-grid">
          <span>应用</span>
          <strong>{metadata?.name ?? pendingLabel}</strong>
          <span>版本</span>
          <strong>{metadata?.version ?? pendingLabel}</strong>
        </div>
        {error ? <p className="profile-dialog-note danger" role="alert">{error}</p> : null}
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="Portiva 默认以本机处理和本机保存为边界。" title="隐私声明" />
        <PolicyList items={privacyItems} />
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="使用 Portiva 前请确认你有权访问目标系统。" title="条款声明" />
        <PolicyList items={termsItems} />
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="连接工具无法替代操作系统和组织安全策略。" title="安全声明" />
        <PolicyList items={securityItems} />
      </section>
    </section>
  );
}

function PolicyList({ items }: { items: string[] }) {
  return (
    <div className="application-policy-list">
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}
