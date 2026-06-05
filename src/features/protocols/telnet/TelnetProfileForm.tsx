import type { TelnetProfile } from "../../../shared/types";
import { TextInput } from "../../../shared/ui";

interface TelnetProfileFormProps {
  profile: TelnetProfile;
}

export function TelnetProfileForm({ profile }: TelnetProfileFormProps) {
  return (
    <div className="protocol-form">
      <label>
        主机
        <TextInput readOnly value={profile.host} />
      </label>
      <label>
        端口
        <TextInput readOnly value={profile.port} />
      </label>
      <label>
        终端
        <TextInput readOnly value={profile.terminalType} />
      </label>
      <label>
        换行
        <TextInput readOnly value={profile.lineEnding.toUpperCase()} />
      </label>
      <p className="todo-note">后续会实现 Telnet 选项协商，并在连接前显示明文风险提醒。</p>
    </div>
  );
}
