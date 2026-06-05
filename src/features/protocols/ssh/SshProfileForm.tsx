import type { SftpProfile, SshProfile } from "../../../shared/types";
import { Select, TextInput, Toggle } from "../../../shared/ui";

type SshCredentialProfile = SshProfile | SftpProfile;

interface SshProfileFormProps {
  hasRememberedSecret?: boolean;
  onChange: (profile: SshCredentialProfile) => void;
  onRememberSecretChange?: (remember: boolean) => void;
  onSecretChange?: (secret: string) => void;
  rememberSecret?: boolean;
  secret?: string;
  profile: SshCredentialProfile;
}

export function SshProfileForm({
  hasRememberedSecret = false,
  onChange,
  onRememberSecretChange,
  onSecretChange,
  profile,
  rememberSecret = false,
  secret = "",
}: SshProfileFormProps) {
  const update = (patch: Partial<SshCredentialProfile>) =>
    onChange({ ...profile, ...patch } as SshCredentialProfile);
  const showsRememberedSecretMask = profile.authType === "password" && hasRememberedSecret && !secret;
  const passwordValue = showsRememberedSecretMask ? "*****" : secret;
  const updatePassword = (value: string) => {
    if (showsRememberedSecretMask && value.startsWith("*****")) {
      onSecretChange?.(value.slice(5));
      return;
    }

    onSecretChange?.(value);
  };

  return (
    <div className="protocol-form">
      <label>
        主机
        <TextInput value={profile.host} onChange={(event) => update({ host: event.target.value })} />
      </label>
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
        <label>
          SSH 密码
          <TextInput
            autoComplete="current-password"
            type="password"
            value={passwordValue}
            onFocus={(event) => {
              if (showsRememberedSecretMask) {
                event.currentTarget.select();
              }
            }}
            onMouseUp={(event) => {
              if (showsRememberedSecretMask) {
                event.preventDefault();
              }
            }}
            onChange={(event) => updatePassword(event.target.value)}
            onCopy={(event) => event.preventDefault()}
            onCut={(event) => event.preventDefault()}
            onContextMenu={(event) => {
              if (showsRememberedSecretMask) {
                event.preventDefault();
              }
            }}
          />
        </label>
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
          <label>
            密钥口令
            <TextInput
              autoComplete="current-password"
              type="password"
              value={secret}
              onChange={(event) => onSecretChange?.(event.target.value)}
            />
          </label>
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
