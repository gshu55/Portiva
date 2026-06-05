import type { SftpProfile, SshProfile } from "../../../shared/types";

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
        <input value={profile.host} onChange={(event) => update({ host: event.target.value })} />
      </label>
      <label>
        端口
        <input
          min="1"
          max="65535"
          type="number"
          value={profile.port}
          onChange={(event) => update({ port: Number(event.target.value) })}
        />
      </label>
      <label>
        用户
        <input value={profile.username} onChange={(event) => update({ username: event.target.value })} />
      </label>
      <label>
        认证
        <select
          value={profile.authType}
          onChange={(event) => {
            onSecretChange?.("");
            onRememberSecretChange?.(false);
            update({ authType: event.target.value as SshProfile["authType"] });
          }}
        >
          <option value="password">密码</option>
          <option value="private-key">私钥</option>
          <option value="agent">Agent</option>
        </select>
      </label>
      {profile.authType === "password" ? (
        <label>
          SSH 密码
          <input
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
            <input
              value={profile.privateKeyPath ?? ""}
              onChange={(event) => update({ privateKeyPath: event.target.value })}
            />
          </label>
          <label>
            密钥口令
            <input
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
          <label className="check-row">
            <input
              checked={rememberSecret}
              type="checkbox"
              onChange={(event) => onRememberSecretChange?.(event.target.checked)}
            />
            <span className="check-row-label">记住密码</span>
          </label>
        ) : null}
        <label className="check-row">
          <input
            checked={Boolean(profile.enableCompression)}
            type="checkbox"
            onChange={(event) => update({ enableCompression: event.target.checked })}
          />
          <span className="check-row-label">压缩</span>
        </label>
      </div>
    </div>
  );
}
