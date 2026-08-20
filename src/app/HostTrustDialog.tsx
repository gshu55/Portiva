import { Icon } from "../shared/Icon";

interface HostTrustDialogProps {
  busy: boolean;
  connectAfterTrust: boolean;
  fingerprint: string;
  host: string;
  hostKeyChanged: boolean;
  profileName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function HostTrustDialog({
  busy,
  connectAfterTrust,
  fingerprint,
  host,
  hostKeyChanged,
  profileName,
  onCancel,
  onConfirm,
}: HostTrustDialogProps) {
  return (
    <div
      className="host-trust-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (!busy) {
          onCancel();
        }
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
          <strong>{hostKeyChanged ? "SSH 主机身份已更改" : "确认信任 SSH 主机"}</strong>
          <button
            aria-label="关闭确认弹窗"
            disabled={busy}
            onClick={onCancel}
            title="关闭确认弹窗"
            type="button"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="host-trust-content">
          <p className={hostKeyChanged ? "host-trust-warning" : undefined}>
            {hostKeyChanged
              ? "保存的主机指纹与当前设备不一致。仅当你确认该 IP 对应的设备确实已更换时继续；确认后会替换旧指纹。"
              : "请核对该主机指纹。确认后会写入 known_hosts，之后同一主机将自动校验。"}
          </p>
          <dl>
            <div>
              <dt>配置</dt>
              <dd>{profileName}</dd>
            </div>
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
          <button disabled={busy} onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-action" disabled={busy} onClick={onConfirm} type="button">
            {busy
              ? "处理中..."
              : hostKeyChanged
                ? connectAfterTrust
                  ? "替换指纹并连接"
                  : "替换指纹"
                : connectAfterTrust
                  ? "信任并连接"
                  : "信任"}
          </button>
        </div>
      </section>
    </div>
  );
}
