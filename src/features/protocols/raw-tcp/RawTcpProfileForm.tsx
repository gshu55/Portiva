import type { RawSocketProfile } from "../../../shared/types";
import { TextInput } from "../../../shared/ui";

interface RawTcpProfileFormProps {
  profile: RawSocketProfile;
}

export function RawTcpProfileForm({ profile }: RawTcpProfileFormProps) {
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
        编码
        <TextInput readOnly value={profile.encoding} />
      </label>
      <label>
        换行
        <TextInput readOnly value={profile.lineEnding.toUpperCase()} />
      </label>
      <p className="todo-note">后续会实现超时、重连策略和明确的明文风险提醒。</p>
    </div>
  );
}
