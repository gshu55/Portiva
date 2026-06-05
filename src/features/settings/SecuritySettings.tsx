import { Button, IconButton, TextArea, Toggle } from "../../shared/ui";
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
          <Toggle
            checked={settings.security.requireHostKeyVerification}
            label="要求 SSH 主机密钥校验"
            onChange={(event) => updateSecurity({ requireHostKeyVerification: event.currentTarget.checked })}
          />
          <Toggle
            checked={settings.security.redactSensitiveLogs}
            label="日志中脱敏敏感字段"
            onChange={(event) => updateSecurity({ redactSensitiveLogs: event.currentTarget.checked })}
          />
          <Toggle
            checked={settings.security.allowInsecureWithoutWarning}
            label="允许不安全协议且不提示"
            onChange={(event) => updateSecurity({ allowInsecureWithoutWarning: event.currentTarget.checked })}
          />
        </div>
      </section>

      <section className="settings-block security-settings-block">
        <SettingsSectionHeader description="使用当前规则检查敏感字段替换结果。" title="日志脱敏预览" />
        <div className="redaction-preview">
          <label className="settings-field">
            <span>脱敏输入</span>
            <TextArea mono value={redactionInput} onChange={(event) => onRedactionInputChange(event.currentTarget.value)} />
          </label>
          <Button aria-label="预览脱敏" icon="refresh-ccw" onClick={onPreviewRedaction} title="预览脱敏">
            <span>预览</span>
          </Button>
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
                <IconButton aria-label={`删除密钥 ${secret.id}`} icon="trash" onClick={() => onDeleteSecretMetadata(secret.id)} title="删除密钥元数据" tone="danger" />
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
                <IconButton aria-label={`删除已知主机 ${host.host}`} icon="trash" onClick={() => onDeleteKnownHost(host.host)} title="删除已知主机" tone="danger" />
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
