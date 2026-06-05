import type { SerialPortInfo, SerialProfile } from "../../../shared/types";

interface SerialProfileFormProps {
  profile: SerialProfile;
  ports?: SerialPortInfo[];
}

export function SerialProfileForm({ ports = [], profile }: SerialProfileFormProps) {
  return (
    <div className="protocol-form">
      <label>
        端口
        <input readOnly value={profile.portName} />
      </label>
      <label>
        波特率
        <input readOnly value={profile.baudRate} />
      </label>
      <label>
        数据位
        <input readOnly value={profile.dataBits} />
      </label>
      <label>
        校验
        <input readOnly value={profile.parity} />
      </label>
      <label>
        流控
        <input readOnly value={profile.flowControl} />
      </label>
      <label>
        换行
        <input readOnly value={profile.lineEnding} />
      </label>
      <label>
        编码
        <input readOnly value={profile.encoding} />
      </label>
      <label>
        DTR
        <input readOnly value={profile.dtr ? "开启" : "关闭"} />
      </label>
      <label>
        RTS
        <input readOnly value={profile.rts ? "开启" : "关闭"} />
      </label>
      <div className="serial-port-list">
        <strong>检测到的端口</strong>
        {ports.map((port) => (
          <div className="serial-port-row" key={port.portName}>
            <span>{port.portName}</span>
            <span>{port.portType}</span>
            <small>{port.isAvailable ? "可用" : "占用"}</small>
          </div>
        ))}
      </div>
      <p className="todo-note">串口连接已接入系统端口枚举、终端读写、DTR/RTS 和拔出错误状态。</p>
    </div>
  );
}
