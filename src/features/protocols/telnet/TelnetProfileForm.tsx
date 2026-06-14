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
      <p className="todo-note">Telnet 会处理基础选项协商，连接时请注意明文传输风险。</p>
    </div>
  );
}
