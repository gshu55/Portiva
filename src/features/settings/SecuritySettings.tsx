import { Icon } from "../../shared/Icon";
import type { AppSettings, KnownHostEntry, SecretMetadata } from "../../shared/types";
import { SettingsSectionHeader } from "./SettingsSection";

interface SecuritySettingsProps {
  knownHosts: KnownHostEntry[];
  redactionInput: string;
  redactionPreview: string;
  secrets: SecretMetadata[];
  settings: AppSettings;
  onDeleteKnownHost: (host: string) => void;
  onDeleteSecretMetadata: (secretId: string) => void;
  onPreviewRedaction: () => void;
  onRedactionInputChange: (value: string) => void;
  onSaveSettings: (settings: AppSettings) => void;
}

export function SecuritySettings({
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
}: SecuritySettingsProps) {
  const updateSecurity = (security: Partial<AppSettings["security"]>) =>
    onSaveSettings({ ...settings, security: { ...settings.security, ...security } });

  return (
    <div className="security-settings">
      <section className="settings-block security-settings-block">
        <SettingsSectionHeader description="主机信任、日志脱敏和协议风险提示。" title="连接保护" />
        <div className="settings-toggle-grid">
          <label className="check-row">
            <input
              checked={settings.security.requireHostKeyVerification}
              type="checkbox"
              onChange={(event) => updateSecurity({ requireHostKeyVerification: event.currentTarget.checked })}
            />
            <span className="check-row-label">要求 SSH 主机密钥校验</span>
          </label>
          <label className="check-row">
            <input
              checked={settings.security.redactSensitiveLogs}
              type="checkbox"
              onChange={(event) => updateSecurity({ redactSensitiveLogs: event.currentTarget.checked })}
            />
            <span className="check-row-label">日志中脱敏敏感字段</span>
          </label>
          <label className="check-row">
            <input
              checked={settings.security.allowInsecureWithoutWarning}
              type="checkbox"
              onChange={(event) => updateSecurity({ allowInsecureWithoutWarning: event.currentTarget.checked })}
            />
            <span className="check-row-label">允许不安全协议且不提示</span>
          </label>
        </div>
      </section>

      <section className="settings-block security-settings-block">
        <SettingsSectionHeader description="使用当前规则检查敏感字段替换结果。" title="日志脱敏预览" />
        <div className="redaction-preview">
          <label className="settings-field">
            <span>脱敏输入</span>
            <textarea value={redactionInput} onChange={(event) => onRedactionInputChange(event.currentTarget.value)} />
          </label>
          <button aria-label="预览脱敏" onClick={onPreviewRedaction} title="预览脱敏" type="button">
            <Icon name="refresh-ccw" />
            <span>预览</span>
          </button>
          <pre>{redactionPreview || "运行预览以查看后端脱敏结果。"}</pre>
        </div>
      </section>

      <section className="settings-block security-settings-block">
        <SettingsSectionHeader description="只显示元数据，实际密钥由后端保管。" meta={`${secrets.length} 项`} title="密钥元数据" />
        <div className="security-list">
          {secrets.length > 0 ? (
            secrets.map((secret) => (
              <div className="security-row" key={secret.id}>
                <span>{secret.purpose}</span>
                <small>{secret.id}</small>
                <button aria-label={`删除密钥 ${secret.id}`} onClick={() => onDeleteSecretMetadata(secret.id)} title="删除密钥元数据" type="button">
                  <Icon name="trash" />
                </button>
              </div>
            ))
          ) : (
            <div className="settings-empty">暂无密钥元数据</div>
          )}
        </div>
      </section>

      <section className="settings-block security-settings-block">
        <SettingsSectionHeader description="保存过的 SSH 主机指纹。" meta={`${knownHosts.length} 台`} title="已知主机" />
        <div className="security-list">
          {knownHosts.length > 0 ? (
            knownHosts.map((host) => (
              <div className="security-row" key={host.host}>
                <span>{host.host}</span>
                <small>{host.fingerprint}</small>
                <button aria-label={`删除已知主机 ${host.host}`} onClick={() => onDeleteKnownHost(host.host)} title="删除已知主机" type="button">
                  <Icon name="trash" />
                </button>
              </div>
            ))
          ) : (
            <div className="settings-empty">暂无已知主机</div>
          )}
        </div>
      </section>
    </div>
  );
}
