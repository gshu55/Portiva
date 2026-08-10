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
  const profileSecrets = secrets.filter((secret) => secret.purpose !== "proxy-password");
  const updateSecurity = (security: Partial<AppSettings["security"]>) =>
    onSaveSettings({ ...settings, security: { ...settings.security, ...security } });

  return (
    <div className="security-settings">
      <section className="settings-block security-settings-block">
        <SettingsSectionHeader title="连接保护" />
        <div className="settings-toggle-grid">
          <Toggle
            checked
            disabled
            label="始终校验 SSH 主机密钥"
          />
          <Toggle
            checked
            disabled
            label="始终脱敏敏感日志字段"
          />
          <Toggle
            checked={settings.security.allowInsecureWithoutWarning}
            label="允许不安全协议且不提示"
            onChange={(event) => updateSecurity({ allowInsecureWithoutWarning: event.currentTarget.checked })}
          />
        </div>
      </section>

      <section className="settings-block security-settings-block">
        <SettingsSectionHeader title="日志脱敏预览" />
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
        <SettingsSectionHeader meta={`${profileSecrets.length} 项`} title="系统凭据" />
        <div className="security-list">
          {profileSecrets.length > 0 ? (
            profileSecrets.map((secret) => (
              <div className="security-row" key={secret.id}>
                <span>{secret.purpose}</span>
                <small>{secret.id}</small>
                <IconButton aria-label={`删除凭据 ${secret.id}`} icon="trash" onClick={() => onDeleteSecretMetadata(secret.id)} title="删除系统凭据" tone="danger" />
              </div>
            ))
          ) : (
            <div className="settings-empty">暂无系统凭据</div>
          )}
        </div>
      </section>

      <section className="settings-block security-settings-block">
        <SettingsSectionHeader meta={`${knownHosts.length} 台`} title="已知主机" />
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
