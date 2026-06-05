import type { TelnetProfile } from "../../../shared/types";

interface TelnetProfileFormProps {
  profile: TelnetProfile;
}

export function TelnetProfileForm({ profile }: TelnetProfileFormProps) {
  return (
    <div className="protocol-form">
      <label>
        主机
        <input readOnly value={profile.host} />
      </label>
      <label>
        端口
        <input readOnly value={profile.port} />
      </label>
      <label>
        终端
        <input readOnly value={profile.terminalType} />
      </label>
      <label>
        换行
        <input readOnly value={profile.lineEnding.toUpperCase()} />
      </label>
      <p className="todo-note">后续会实现 Telnet 选项协商，并在连接前显示明文风险提醒。</p>
    </div>
  );
}
