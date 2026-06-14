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
      <p className="todo-note">Raw TCP 使用明文 TCP 字节流，支持当前终端的换行和编码设置，可通过标签重连。</p>
    </div>
  );
}
