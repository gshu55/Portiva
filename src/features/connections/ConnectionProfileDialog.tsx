import { useEffect, useState } from "react";
import type {
  ConnectionProfile,
  RawSocketProfile,
  SerialPortInfo,
  SerialProfile,
  TelnetProfile,
  TextEncoding,
} from "../../shared/types";
import { protocolLabel } from "../../shared/labels";
import type { IconName } from "../../shared/Icon";
import type { TestConnectionResult } from "../../shared/ipc/commands";
import { IconButton, Select, SegmentedControl, TextInput, Toggle } from "../../shared/ui";
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
  rememberedSecret?: boolean;
  serialPorts?: SerialPortInfo[];
  onCreateDraft: (type: ConnectionProfile["type"]) => ConnectionProfile;
  onClose: () => void;
  onConnect: (profile: ConnectionProfile, input?: ConnectionSecretInput) => Promise<ConnectionActionResult>;
  onDelete: (profileId: string) => void;
  onRefreshSerialPorts?: () => Promise<SerialPortInfo[]> | Promise<void> | SerialPortInfo[] | void;
  onSave: (profile: ConnectionProfile, input?: ConnectionSecretInput) => Promise<ConnectionActionResult>;
  onTest: (profile: ConnectionProfile, input?: ConnectionSecretInput) => Promise<TestConnectionResult>;
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

  useEffect(() => {
    setDraft(profile);
    setRememberSecret(rememberedSecret);
    setSecret("");
    setTestResult(null);
    setConnectResult(null);
    setSaveResult(null);
  }, [profile, rememberedSecret]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const title = `${mode === "create" ? "新建" : "编辑"} ${protocolLabel(draft.type)} 配置`;
  const canSave = canSaveProfile(draft);
  const needsConnectionSecret =
    (draft.type === "ssh" || draft.type === "sftp") && draft.authType === "password";
  const canUseRememberedSecret = needsConnectionSecret && rememberSecret && rememberedSecret;
  const canConnect = canSave && (!needsConnectionSecret || Boolean(secret) || canUseRememberedSecret);
  const canTest = canSave && (!needsConnectionSecret || Boolean(secret));

  const connectDraft = async () => {
    setConnectResult(null);
    setSaveResult(null);
    setTestResult(null);

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
          <IconButton aria-label="关闭弹窗" icon="x" onClick={onClose} title="关闭弹窗" />
        </div>

        <div className="profile-dialog-body">
          {mode === "create" ? (
            <aside className="profile-dialog-left" aria-label="连接类型">
              <SegmentedControl
                aria-label="连接类型"
                className="segmented-control profile-type-control"
                itemLayout="iconText"
                options={(["ssh", "sftp", "telnet", "raw-tcp"] as const).map((type) => ({
                  ariaLabel: protocolLabel(type),
                  icon: profileTypeIcons[type],
                  label: protocolLabel(type),
                  title: protocolLabel(type),
                  value: type,
                }))}
                orientation="vertical"
                value={draft.type === "serial" ? "ssh" : draft.type}
                onChange={(type) => {
                  setSecret("");
                  setDraft(onCreateDraft(type));
                }}
              />
            </aside>
          ) : null}

          <div className="profile-dialog-right" aria-label="连接参数">
            <label>
              配置名称
              <TextInput
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
            </label>
            {draft.type === "ssh" || draft.type === "sftp" ? (
              <>
                <SshProfileForm
                  hasRememberedSecret={rememberSecret && rememberedSecret}
                  profile={draft}
                  rememberSecret={rememberSecret}
                  secret={secret}
                  onChange={(profile) => setDraft(profile)}
                  onRememberSecretChange={setRememberSecret}
                  onSecretChange={setSecret}
                />
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
            <div className="profile-dialog-actions-left">
              {mode === "edit" ? (
                <IconButton aria-label="删除配置" className="danger-action" icon="trash" onClick={() => onDelete(draft.id)} title="删除配置" tone="danger" />
              ) : null}
              <IconButton
                aria-label="测试连接"
                disabled={!canTest}
                icon="terminal"
                onClick={() => void testDraft()}
                title={canTest ? "测试连接" : "请输入密码后再测试连接"}
              />
            </div>
            <div className="profile-dialog-actions-right">
              <IconButton
                aria-label="连接"
                disabled={!canConnect}
                icon="plug"
                onClick={() => void connectDraft()}
                title="连接"
              />
              <IconButton aria-label="保存配置" disabled={!canSave} icon="save" onClick={() => void saveDraft()} title="保存配置" tone="primary" />
            </div>
          </div>
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
        <TextInput value={profile.host} onChange={(event) => update({ host: event.currentTarget.value })} />
      </label>
      <label>
        端口
        <TextInput
          min="1"
          max="65535"
          type="number"
          value={profile.port}
          onChange={(event) => update({ port: Number(event.currentTarget.value) })}
        />
      </label>
      <label>
        用户
        <TextInput value={profile.username ?? ""} onChange={(event) => update({ username: event.currentTarget.value })} />
      </label>
      <label>
        终端
        <Select
          value={profile.terminalType}
          options={[
            { label: "xterm", value: "xterm" },
            { label: "vt100", value: "vt100" },
            { label: "vt220", value: "vt220" },
          ]}
          onChange={(terminalType) => update({ terminalType: terminalType as TelnetProfile["terminalType"] })}
        />
      </label>
      <EncodingFields
        encoding={profile.encoding}
        lineEnding={profile.lineEnding}
        onChange={(patch) => update(patch)}
      />
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
        <TextInput value={profile.host} onChange={(event) => update({ host: event.currentTarget.value })} />
      </label>
      <label>
        端口
        <TextInput
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
  onRefreshPorts?: () => Promise<SerialPortInfo[]> | Promise<void> | SerialPortInfo[] | void;
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
          <Select
            disabled={!ports.length && !profile.portName}
            value={profile.portName}
            placeholder={ports.length ? "选择串口端口" : "未检测到串口端口"}
            options={[
              ...(profile.portName && !selectedPortIsDetected ? [{ label: `${profile.portName}（当前配置）`, value: profile.portName }] : []),
              ...ports.map((port) => ({
                disabled: !port.isAvailable && port.portName !== profile.portName,
                label: `${port.displayName || port.portName}${port.isAvailable ? "" : "（占用）"}`,
                value: port.portName,
              })),
            ]}
            onChange={(portName) => update({ portName })}
          />
          <IconButton
            aria-label="刷新串口端口"
            disabled={!onRefreshPorts}
            icon="refresh-ccw"
            onClick={() => void onRefreshPorts?.()}
            title="刷新串口端口"
          />
        </span>
      </label>
      <label>
        波特率
        <TextInput
          min="1"
          type="number"
          value={profile.baudRate}
          onChange={(event) => update({ baudRate: Number(event.currentTarget.value) })}
        />
      </label>
      <label>
        数据位
        <Select
          value={profile.dataBits}
          options={[5, 6, 7, 8].map((value) => ({ label: value, value }))}
          onChange={(dataBits) => update({ dataBits: dataBits as SerialProfile["dataBits"] })}
        />
      </label>
      <label>
        校验
        <Select
          value={profile.parity}
          options={[
            ...(isUnsupportedSerialParity(profile.parity) ? [{ disabled: true, label: `${profile.parity}（暂不支持）`, value: profile.parity }] : []),
            { label: "无", value: "none" },
            { label: "奇校验", value: "odd" },
            { label: "偶校验", value: "even" },
          ]}
          onChange={(parity) => update({ parity: parity as SerialProfile["parity"] })}
        />
      </label>
      <label>
        停止位
        <Select
          value={profile.stopBits}
          options={[
            ...(profile.stopBits === 1.5 ? [{ disabled: true, label: "1.5（暂不支持）", value: 1.5 }] : []),
            { label: "1", value: 1 },
            { label: "2", value: 2 },
          ]}
          onChange={(stopBits) => update({ stopBits: stopBits as SerialProfile["stopBits"] })}
        />
      </label>
      <label>
        流控
        <Select
          value={profile.flowControl}
          options={[
            { label: "无", value: "none" },
            { label: "软件", value: "software" },
            { label: "硬件", value: "hardware" },
          ]}
          onChange={(flowControl) => update({ flowControl: flowControl as SerialProfile["flowControl"] })}
        />
      </label>
      <div className="serial-toggle-grid">
        <Toggle
          checked={Boolean(profile.dtr)}
          description="连接后置位 Data Terminal Ready"
          label="DTR"
          onChange={(event) => update({ dtr: event.currentTarget.checked })}
        />
        <Toggle
          checked={Boolean(profile.rts)}
          description="连接后置位 Request To Send"
          label="RTS"
          onChange={(event) => update({ rts: event.currentTarget.checked })}
        />
      </div>
      <EncodingFields encoding={profile.encoding} lineEnding={profile.lineEnding} onChange={(patch) => update(patch)} />
      <p className="todo-note">串口端口来自系统检测结果，设备重插后可点击刷新重新检测。</p>
    </div>
  );
}

const textEncodingOptions: Array<{ label: string; value: TextEncoding }> = [
  { label: "ASCII", value: "ascii" },
  { label: "UTF-8", value: "utf-8" },
  { label: "GBK", value: "gbk" },
  { label: "Big5", value: "big5" },
  { label: "Shift_JIS", value: "shift-jis" },
  { label: "EUC-KR", value: "euc-kr" },
  { label: "UTF-16 LE", value: "utf-16le" },
  { label: "UTF-16 BE", value: "utf-16be" },
  { label: "Latin-1", value: "latin1" },
];

function EncodingFields({
  encoding,
  lineEnding,
  onChange,
}: {
  encoding: TextEncoding;
  lineEnding: "crlf" | "cr" | "lf";
  onChange: (patch: { encoding?: TextEncoding; lineEnding?: "crlf" | "cr" | "lf" }) => void;
}) {
  return (
    <>
      <label>
        编码
        <Select
          value={encoding}
          options={textEncodingOptions}
          onChange={(nextEncoding) => onChange({ encoding: nextEncoding as TextEncoding })}
        />
      </label>
      <label>
        换行
        <Select
          value={lineEnding}
          options={[
            { label: "CRLF", value: "crlf" },
            { label: "CR", value: "cr" },
            { label: "LF", value: "lf" },
          ]}
          onChange={(nextLineEnding) => onChange({ lineEnding: nextLineEnding as "crlf" | "cr" | "lf" })}
        />
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
    profile.stopBits !== 1.5
  );
}
