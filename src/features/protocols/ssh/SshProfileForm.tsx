import { useEffect, useState, type ReactNode } from "react";
import type { SftpProfile, SshProfile } from "../../../shared/types";
import { IconButton, Select, TextInput, Toggle } from "../../../shared/ui";

type SshCredentialProfile = SshProfile | SftpProfile;

interface SshProfileFormProps {
  afterHost?: ReactNode;
  hasRememberedSecret?: boolean;
  onChange: (profile: SshCredentialProfile) => void;
  onRememberSecretChange?: (remember: boolean) => void;
  onSecretChange?: (secret: string) => void;
  rememberSecret?: boolean;
  secret?: string;
  secretLoading?: boolean;
  profile: SshCredentialProfile;
}

export function SshProfileForm({
  afterHost,
  hasRememberedSecret = false,
  onChange,
  onRememberSecretChange,
  onSecretChange,
  profile,
  rememberSecret = false,
  secret = "",
  secretLoading = false,
}: SshProfileFormProps) {
  const [secretVisible, setSecretVisible] = useState(false);
  const update = (patch: Partial<SshCredentialProfile>) =>
    onChange({ ...profile, ...patch } as SshCredentialProfile);

  useEffect(() => {
    setSecretVisible(false);
  }, [profile.authType, profile.id]);

  useEffect(() => {
    if (!secret) {
      setSecretVisible(false);
    }
  }, [secret]);

  const passwordPlaceholder = secretLoading
    ? "正在读取已保存密码…"
    : hasRememberedSecret && !secret
      ? "未能读取已保存密码"
      : undefined;

  const secretInput = (label: string, autoComplete: "current-password" | "off") => (
    <label>
      {label}
      <span className="secret-field-control">
        <TextInput
          aria-label={label}
          autoCapitalize="none"
          autoComplete={autoComplete}
          disabled={secretLoading}
          placeholder={passwordPlaceholder}
          spellCheck={false}
          type={secretVisible ? "text" : "password"}
          value={secret}
          onChange={(event) => onSecretChange?.(event.target.value)}
          onCopy={(event) => event.preventDefault()}
          onCut={(event) => event.preventDefault()}
        />
        <IconButton
          active={secretVisible}
          aria-label={secretVisible ? "隐藏密码" : "显示密码"}
          aria-pressed={secretVisible}
          className="secret-field-visibility"
          disabled={secretLoading || !secret}
          icon={secretVisible ? "eye-off" : "eye"}
          title={secretVisible ? "隐藏密码" : "显示密码"}
          onClick={() => setSecretVisible((visible) => !visible)}
          onMouseDown={(event) => event.preventDefault()}
        />
      </span>
    </label>
  );

  return (
    <div className="protocol-form">
      <label>
        主机
        <TextInput value={profile.host} onChange={(event) => update({ host: event.target.value })} />
      </label>
      {afterHost}
      <label>
        端口
        <TextInput
          min="1"
          max="65535"
          type="number"
          value={profile.port}
          onChange={(event) => update({ port: Number(event.target.value) })}
        />
      </label>
      <label>
        用户
        <TextInput value={profile.username} onChange={(event) => update({ username: event.target.value })} />
      </label>
      <label>
        认证
        <Select
          value={profile.authType}
          options={[
            { label: "密码", value: "password" },
            { label: "私钥", value: "private-key" },
            { label: "Agent", value: "agent" },
          ]}
          onChange={(authType) => {
            onSecretChange?.("");
            onRememberSecretChange?.(false);
            update({ authType: authType as SshProfile["authType"] });
          }}
        />
      </label>
      {profile.authType === "password" ? (
        secretInput("SSH 密码", "current-password")
      ) : null}
      {profile.authType === "private-key" ? (
        <>
          <label>
            私钥路径
            <TextInput
              value={profile.privateKeyPath ?? ""}
              onChange={(event) => update({ privateKeyPath: event.target.value })}
            />
          </label>
          {secretInput("密钥口令", "off")}
        </>
      ) : null}
      <div className="protocol-option-row">
        {profile.authType === "password" ? (
          <Toggle
            checked={rememberSecret}
            label="记住密码"
            onChange={(event) => onRememberSecretChange?.(event.target.checked)}
          />
        ) : null}
        <Toggle
          checked={Boolean(profile.enableCompression)}
          label="压缩"
          onChange={(event) => update({ enableCompression: event.target.checked })}
        />
      </div>
    </div>
  );
}
