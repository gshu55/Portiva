import type { RawSocketProfile } from "../../../shared/types";

interface RawTcpProfileFormProps {
  profile: RawSocketProfile;
}

export function RawTcpProfileForm({ profile }: RawTcpProfileFormProps) {
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
        编码
        <input readOnly value={profile.encoding} />
      </label>
      <label>
        换行
        <input readOnly value={profile.lineEnding.toUpperCase()} />
      </label>
      <p className="todo-note">后续会实现超时、重连策略和明确的明文风险提醒。</p>
    </div>
  );
}
