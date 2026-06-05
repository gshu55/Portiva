import { useEffect, useState } from "react";
import type {
  ConnectionProfile,
  RawSocketProfile,
  SerialPortInfo,
  SerialProfile,
  TelnetProfile,
} from "../../shared/types";
import { protocolLabel } from "../../shared/labels";
import { Icon, type IconName } from "../../shared/Icon";
import type { TestConnectionResult } from "../../shared/ipc/commands";
import { SshProfileForm } from "../protocols/ssh/SshProfileForm";

export interface ConnectionSecretInput {
  rememberSecret?: boolean;
  secret?: string;
}

export interface ConnectionActionResult {
  message: string;
  needsTrust?: boolean;
  ok: boolean;
}

interface ConnectionProfileDialogProps {
  mode: "create" | "edit";
  profile: ConnectionProfile;
  pendingKnownHost?: { fingerprint: string; host: string } | null;
  rememberedSecret?: boolean;
  serialPorts?: SerialPortInfo[];
  onCreateDraft: (type: ConnectionProfile["type"]) => ConnectionProfile;
  onClose: () => void;
  onConnect: (profile: ConnectionProfile, input?: ConnectionSecretInput) => Promise<ConnectionActionResult>;
  onDelete: (profileId: string) => void;
  onRefreshSerialPorts?: () => Promise<void> | void;
  onSave: (profile: ConnectionProfile, input?: ConnectionSecretInput) => Promise<ConnectionActionResult>;
  onTest: (profile: ConnectionProfile, input?: ConnectionSecretInput) => Promise<TestConnectionResult>;
  onTrustHost: (profile: ConnectionProfile) => boolean | Promise<boolean>;
}

const profileTypeIcons: Record<ConnectionProfile["type"], IconName> = {
  "raw-tcp": "server",
  serial: "plug",
  sftp: "folder-open",
  ssh: "terminal",
  telnet: "network",
};

export function ConnectionProfileDialog({
  mode,
  onCreateDraft,
  onClose,
  onConnect,
  onDelete,
  onRefreshSerialPorts,
  onSave,
  onTest,
  onTrustHost,
  pendingKnownHost,
  profile,
  rememberedSecret = false,
  serialPorts = [],
}: ConnectionProfileDialogProps) {
  const [draft, setDraft] = useState(profile);
  const [rememberSecret, setRememberSecret] = useState(false);
  const [secret, setSecret] = useState("");
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [connectResult, setConnectResult] = useState<ConnectionActionResult | null>(null);
  const [saveResult, setSaveResult] = useState<ConnectionActionResult | null>(null);
  const [trustPromptOpen, setTrustPromptOpen] = useState(false);
  const [connectAfterTrust, setConnectAfterTrust] = useState(false);

  useEffect(() => {
    setDraft(profile);
    setRememberSecret(rememberedSecret);
    setSecret("");
    setTestResult(null);
    setConnectResult(null);
    setSaveResult(null);
    setTrustPromptOpen(false);
    setConnectAfterTrust(false);
  }, [profile, rememberedSecret]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (trustPromptOpen) {
          setTrustPromptOpen(false);
          setConnectAfterTrust(false);
          event.stopPropagation();
          return;
        }

        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, trustPromptOpen]);

  const title = `${mode === "create" ? "新建" : "编辑"} ${protocolLabel(draft.type)} 配置`;
  const canSave = canSaveProfile(draft);
  const needsConnectionSecret =
    (draft.type === "ssh" || draft.type === "sftp") && draft.authType === "password";
  const canConnect = canSave && (!needsConnectionSecret || Boolean(secret));
  const canTest = canSave && (!needsConnectionSecret || Boolean(secret));
  const pendingHost =
    (draft.type === "ssh" || draft.type === "sftp") && pendingKnownHost?.host === draft.host
      ? pendingKnownHost
      : null;

  useEffect(() => {
    if (pendingHost) {
      setTrustPromptOpen(true);
    } else {
      setTrustPromptOpen(false);
      setConnectAfterTrust(false);
    }
  }, [pendingHost]);

  const trustPendingHost = async () => {
    if (!pendingHost) {
      return;
    }

    const trusted = await onTrustHost(draft);
    if (!trusted) {
      return;
    }

    setTrustPromptOpen(false);
    const shouldConnect = connectAfterTrust;
    setConnectAfterTrust(false);
    setTestResult(null);

    if (shouldConnect) {
      const result = await onConnect(draft, { rememberSecret, secret });
      if (!result.ok) {
        setConnectResult(result);
      }
    }
  };

  const connectDraft = async () => {
    setConnectResult(null);
    setSaveResult(null);
    setTestResult(null);

    if (pendingHost) {
      setConnectAfterTrust(true);
      setTrustPromptOpen(true);
      return;
    }

    setConnectAfterTrust(true);
    const result = await onConnect(draft, { rememberSecret, secret });
    if (!result.ok && !result.needsTrust) {
      setConnectResult(result);
    }
  };
  const testDraft = async () => {
    setTestResult(null);
    setConnectResult(null);
    setSaveResult(null);
    const result = await onTest(draft, { rememberSecret, secret });
    setTestResult(result);
    if (result.requiresFingerprintConfirmation) {
      setConnectAfterTrust(false);
      setTrustPromptOpen(true);
    }
  };
  const saveDraft = async () => {
    setSaveResult(null);
    setConnectResult(null);
    setTestResult(null);
    const result = await onSave(draft, { rememberSecret, secret });
    if (!result.ok) {
      setSaveResult(result);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={title}
        aria-modal="true"
        className={["profile-dialog", mode === "edit" ? "edit-mode" : ""].filter(Boolean).join(" ")}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="profile-dialog-heading">
          <div>
            <strong>{title}</strong>
            <span>{mode === "create" ? "填写连接参数后保存" : "修改名称即可重命名"}</span>
          </div>
          <button aria-label="关闭弹窗" onClick={onClose} title="关闭弹窗" type="button">
            <Icon name="x" />
          </button>
        </div>

        <div className="profile-dialog-body">
          {mode === "create" ? (
            <aside className="profile-dialog-left" aria-label="连接类型">
              <div className="segmented-control profile-type-control" aria-label="连接类型">
                {(["ssh", "sftp", "telnet", "serial", "raw-tcp"] as const).map((type) => (
                  <button
                    aria-label={protocolLabel(type)}
                    className={draft.type === type ? "active" : ""}
                    key={type}
                    onClick={() => {
                      setSecret("");
                      setDraft(onCreateDraft(type));
                    }}
                    title={protocolLabel(type)}
                    type="button"
                  >
                    <Icon name={profileTypeIcons[type]} />
                    <span>{protocolLabel(type)}</span>
                  </button>
                ))}
              </div>
            </aside>
          ) : null}

          <div className="profile-dialog-right" aria-label="连接参数">
            <label>
              配置名称
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
            </label>
            {draft.type === "ssh" || draft.type === "sftp" ? (
              <>
                <SshProfileForm
                  profile={draft}
                  rememberSecret={rememberSecret}
                  secret={secret}
                  onChange={(profile) => setDraft(profile)}
                  onRememberSecretChange={setRememberSecret}
                  onSecretChange={setSecret}
                />
                {pendingHost ? (
                  <p className="profile-dialog-note attention">
                    当前主机需要确认信任，请在弹窗中核对指纹。
                  </p>
                ) : null}
              </>
            ) : null}
            {draft.type === "telnet" ? (
              <TelnetFields profile={draft} onChange={(profile) => setDraft(profile)} />
            ) : null}
            {draft.type === "serial" ? (
              <SerialFields
                ports={serialPorts}
                profile={draft}
                onRefreshPorts={onRefreshSerialPorts}
                onChange={(profile) => setDraft(profile)}
              />
            ) : null}
            {draft.type === "raw-tcp" ? (
              <RawTcpFields profile={draft} onChange={(profile) => setDraft(profile)} />
            ) : null}
            {testResult ? (
              <p className={["profile-dialog-note", testResult.ok ? "success" : "danger"].join(" ")}>
                {testResult.ok ? "测试成功：" : "测试失败："}{testResult.message}
              </p>
            ) : null}
            {connectResult ? (
              <p className={["profile-dialog-note", connectResult.ok ? "success" : "danger"].join(" ")}>
                {connectResult.ok ? "连接成功：" : "连接失败："}{connectResult.message}
              </p>
            ) : null}
            {saveResult ? (
              <p className={["profile-dialog-note", saveResult.ok ? "success" : "danger"].join(" ")}>
                {saveResult.ok ? "保存成功：" : "保存失败："}{saveResult.message}
              </p>
            ) : null}
          </div>

          <div className="profile-dialog-actions">
            {mode === "edit" ? (
              <button aria-label="删除配置" className="danger-action" onClick={() => onDelete(draft.id)} title="删除配置" type="button">
                <Icon name="trash" />
              </button>
            ) : null}
            <div>
              <button
                aria-label="测试连接"
                disabled={!canTest}
                onClick={() => void testDraft()}
                title={canTest ? "测试连接" : "请输入密码后再测试连接"}
                type="button"
              >
                <Icon name="terminal" />
              </button>
              <button
                aria-label={pendingHost ? "信任并连接" : "连接"}
                disabled={!canConnect}
                onClick={() => void connectDraft()}
                title={pendingHost ? "信任并连接" : "连接"}
                type="button"
              >
                <Icon name="plug" />
              </button>
              <button aria-label="保存配置" disabled={!canSave} onClick={() => void saveDraft()} title="保存配置" type="button">
                <Icon name="save" />
              </button>
            </div>
          </div>
        </div>
        {pendingHost && trustPromptOpen ? (
          <HostTrustDialog
            host={pendingHost.host}
            fingerprint={pendingHost.fingerprint}
            connectAfterTrust={connectAfterTrust}
            onCancel={() => {
              setTrustPromptOpen(false);
              setConnectAfterTrust(false);
            }}
            onConfirm={() => void trustPendingHost()}
          />
        ) : null}
      </section>
    </div>
  );
}

function HostTrustDialog({
  connectAfterTrust,
  fingerprint,
  host,
  onCancel,
  onConfirm,
}: {
  connectAfterTrust: boolean;
  fingerprint: string;
  host: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="host-trust-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        onCancel();
      }}
    >
      <section
        aria-label="确认信任主机"
        aria-modal="true"
        className="host-trust-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="host-trust-heading">
          <strong>确认信任主机</strong>
          <button aria-label="关闭确认弹窗" onClick={onCancel} title="关闭确认弹窗" type="button">
            <Icon name="x" />
          </button>
        </div>
        <div className="host-trust-content">
          <p>请确认该 SSH 主机指纹可信，信任后会写入 known_hosts。</p>
          <dl>
            <div>
              <dt>主机</dt>
              <dd>{host}</dd>
            </div>
            <div>
              <dt>指纹</dt>
              <dd>{fingerprint}</dd>
            </div>
          </dl>
        </div>
        <div className="host-trust-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-action" onClick={onConfirm} type="button">
            {connectAfterTrust ? "信任并连接" : "信任"}
          </button>
        </div>
      </section>
    </div>
  );
}

function TelnetFields({
  onChange,
  profile,
}: {
  onChange: (profile: TelnetProfile) => void;
  profile: TelnetProfile;
}) {
  const update = (patch: Partial<TelnetProfile>) => onChange({ ...profile, ...patch });

  return (
    <div className="protocol-form">
      <label>
        主机
        <input value={profile.host} onChange={(event) => update({ host: event.currentTarget.value })} />
      </label>
      <label>
        端口
        <input
          min="1"
          max="65535"
          type="number"
          value={profile.port}
          onChange={(event) => update({ port: Number(event.currentTarget.value) })}
        />
      </label>
      <label>
        用户
        <input value={profile.username ?? ""} onChange={(event) => update({ username: event.currentTarget.value })} />
      </label>
      <label>
        终端
        <select value={profile.terminalType} onChange={(event) => update({ terminalType: event.currentTarget.value as TelnetProfile["terminalType"] })}>
          <option value="xterm">xterm</option>
          <option value="vt100">vt100</option>
          <option value="vt220">vt220</option>
        </select>
      </label>
      <EncodingFields
        encoding={profile.encoding}
        lineEnding={profile.lineEnding}
        onChange={(patch) => update(patch)}
      />
      <p className="todo-note">Telnet 后端尚未启用；当前可先保存配置。</p>
    </div>
  );
}

function RawTcpFields({
  onChange,
  profile,
}: {
  onChange: (profile: RawSocketProfile) => void;
  profile: RawSocketProfile;
}) {
  const update = (patch: Partial<RawSocketProfile>) => onChange({ ...profile, ...patch });

  return (
    <div className="protocol-form">
      <label>
        主机
        <input value={profile.host} onChange={(event) => update({ host: event.currentTarget.value })} />
      </label>
      <label>
        端口
        <input
          min="1"
          max="65535"
          type="number"
          value={profile.port}
          onChange={(event) => update({ port: Number(event.currentTarget.value) })}
        />
      </label>
      <EncodingFields
        encoding={profile.encoding}
        lineEnding={profile.lineEnding}
        onChange={(patch) => update(patch)}
      />
      <p className="todo-note">Raw TCP 后端尚未启用；当前可先保存配置。</p>
    </div>
  );
}

function SerialFields({
  onChange,
  onRefreshPorts,
  ports,
  profile,
}: {
  onChange: (profile: SerialProfile) => void;
  onRefreshPorts?: () => Promise<void> | void;
  ports: SerialPortInfo[];
  profile: SerialProfile;
}) {
  const update = (patch: Partial<SerialProfile>) => onChange({ ...profile, ...patch });
  const selectedPortIsDetected = ports.some((port) => port.portName === profile.portName);

  return (
    <div className="protocol-form">
      <label>
        端口
        <span className="serial-port-control">
          <select
            disabled={!ports.length && !profile.portName}
            value={profile.portName}
            onChange={(event) => update({ portName: event.currentTarget.value })}
          >
            <option disabled value="">
              {ports.length ? "选择串口端口" : "未检测到串口端口"}
            </option>
            {profile.portName && !selectedPortIsDetected ? (
              <option value={profile.portName}>{profile.portName}（当前配置）</option>
            ) : null}
            {ports.map((port) => (
              <option disabled={!port.isAvailable && port.portName !== profile.portName} key={port.portName} value={port.portName}>
                {port.displayName || port.portName}
                {port.isAvailable ? "" : "（占用）"}
              </option>
            ))}
          </select>
          <button
            aria-label="刷新串口端口"
            disabled={!onRefreshPorts}
            onClick={() => void onRefreshPorts?.()}
            title="刷新串口端口"
            type="button"
          >
            <Icon name="refresh-ccw" />
          </button>
        </span>
      </label>
      <label>
        波特率
        <input
          min="1"
          type="number"
          value={profile.baudRate}
          onChange={(event) => update({ baudRate: Number(event.currentTarget.value) })}
        />
      </label>
      <label>
        数据位
        <select value={profile.dataBits} onChange={(event) => update({ dataBits: Number(event.currentTarget.value) as SerialProfile["dataBits"] })}>
          <option value={5}>5</option>
          <option value={6}>6</option>
          <option value={7}>7</option>
          <option value={8}>8</option>
        </select>
      </label>
      <label>
        校验
        <select value={profile.parity} onChange={(event) => update({ parity: event.currentTarget.value as SerialProfile["parity"] })}>
          {isUnsupportedSerialParity(profile.parity) ? (
            <option disabled value={profile.parity}>
              {profile.parity}（暂不支持）
            </option>
          ) : null}
          <option value="none">无</option>
          <option value="odd">奇校验</option>
          <option value="even">偶校验</option>
        </select>
      </label>
      <label>
        停止位
        <select value={profile.stopBits} onChange={(event) => update({ stopBits: Number(event.currentTarget.value) as SerialProfile["stopBits"] })}>
          {profile.stopBits === 1.5 ? (
            <option disabled value={1.5}>
              1.5（暂不支持）
            </option>
          ) : null}
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
      </label>
      <label>
        流控
        <select value={profile.flowControl} onChange={(event) => update({ flowControl: event.currentTarget.value as SerialProfile["flowControl"] })}>
          <option value="none">无</option>
          <option value="software">软件</option>
          <option value="hardware">硬件</option>
        </select>
      </label>
      <div className="serial-toggle-grid">
        <label className="check-row">
          <input
            checked={Boolean(profile.dtr)}
            type="checkbox"
            onChange={(event) => update({ dtr: event.currentTarget.checked })}
          />
          <span className="check-row-label">
            <strong>DTR</strong>
            <small>连接后置位 Data Terminal Ready</small>
          </span>
        </label>
        <label className="check-row">
          <input
            checked={Boolean(profile.rts)}
            type="checkbox"
            onChange={(event) => update({ rts: event.currentTarget.checked })}
          />
          <span className="check-row-label">
            <strong>RTS</strong>
            <small>连接后置位 Request To Send</small>
          </span>
        </label>
      </div>
      <EncodingFields
        encoding={profile.encoding}
        includeGbk={false}
        lineEnding={profile.lineEnding}
        onChange={(patch) => update(patch)}
      />
      <p className="todo-note">串口端口来自系统检测结果，设备重插后可点击刷新重新检测。</p>
    </div>
  );
}

function EncodingFields({
  encoding,
  includeGbk = true,
  lineEnding,
  onChange,
}: {
  encoding: "utf-8" | "gbk" | "latin1";
  includeGbk?: boolean;
  lineEnding: "crlf" | "cr" | "lf";
  onChange: (patch: { encoding?: "utf-8" | "gbk" | "latin1"; lineEnding?: "crlf" | "cr" | "lf" }) => void;
}) {
  return (
    <>
      <label>
        编码
        <select value={encoding} onChange={(event) => onChange({ encoding: event.currentTarget.value as "utf-8" | "gbk" | "latin1" })}>
          {!includeGbk && encoding === "gbk" ? (
            <option disabled value="gbk">
              GBK（暂不支持）
            </option>
          ) : null}
          <option value="utf-8">UTF-8</option>
          {includeGbk ? <option value="gbk">GBK</option> : null}
          <option value="latin1">Latin-1</option>
        </select>
      </label>
      <label>
        换行
        <select value={lineEnding} onChange={(event) => onChange({ lineEnding: event.currentTarget.value as "crlf" | "cr" | "lf" })}>
          <option value="crlf">CRLF</option>
          <option value="cr">CR</option>
          <option value="lf">LF</option>
        </select>
      </label>
    </>
  );
}

function canSaveProfile(profile: ConnectionProfile) {
  if (!profile.name.trim()) {
    return false;
  }

  if (profile.type === "serial") {
    return Boolean(profile.portName.trim()) && isSupportedSerialConfiguration(profile);
  }

  if (!profile.host.trim() || profile.port < 1 || profile.port > 65535) {
    return false;
  }

  if (profile.type === "ssh" || profile.type === "sftp") {
    if (!profile.username.trim()) {
      return false;
    }

    return profile.authType !== "private-key" || Boolean(profile.privateKeyPath?.trim());
  }

  return true;
}

function isUnsupportedSerialParity(parity: SerialProfile["parity"]) {
  return parity === "mark" || parity === "space";
}

function isSupportedSerialConfiguration(profile: SerialProfile) {
  return (
    !isUnsupportedSerialParity(profile.parity) &&
    profile.stopBits !== 1.5 &&
    profile.encoding !== "gbk"
  );
}
