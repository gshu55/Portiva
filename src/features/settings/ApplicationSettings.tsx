import { useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Icon } from "../../shared/Icon";
import { Button, Tag } from "../../shared/ui";
import { useAppMetadata } from "../../shared/useAppMetadata";
import { SettingsSectionHeader } from "./SettingsSection";

type UpdatePhase = "available" | "checking" | "current" | "downloading" | "error" | "idle" | "installing";

interface UpdateState {
  downloadedBytes: number;
  message: string;
  phase: UpdatePhase;
  progress: number | null;
  releaseNotes: string | null;
  totalBytes: number | null;
  version: string | null;
}

const initialUpdateState: UpdateState = {
  downloadedBytes: 0,
  message: "获取经过签名验证的稳定版本。",
  phase: "idle",
  progress: null,
  releaseNotes: null,
  totalBytes: null,
  version: null,
};

const privacyItems = [
  "连接配置、工作区设置、已知主机记录和凭据元数据默认保存在本机。",
  "终端内容、HTTP 请求数据、文件传输路径和日志不会由 Portiva 自动上传到任何远程服务。",
  "剪贴板、文件系统、网络连接和密钥访问只会在你主动执行相关操作时使用。",
  "敏感字段可能会在本地日志中脱敏显示，但你仍应避免在共享屏幕或导出的日志中暴露私密信息。",
];

const termsItems = [
  "继续访问、启动或使用 Portiva，即表示你已阅读、理解并同意本页隐私声明、条款声明和安全说明；如果你不同意相关内容，应停止使用本软件。",
  "你应仅连接自己拥有、管理或已获授权访问的主机、设备和网络服务。",
  "你需要自行确认连接目标、传输内容、命令执行和文件操作符合所在组织及当地法律法规要求。",
  "Telnet、Raw TCP、FTP 等非加密协议可能以明文传输数据，建议只在可信网络或实验环境中使用。",
  "本软件按现状提供；使用过程中产生的数据丢失、服务中断或远端操作后果由操作者自行评估和承担。",
];

const securityItems = [
  "SSH/SFTP 密码和私钥口令使用系统安全存储；HTTP 请求认证字段按当前产品约定随本地请求草稿明文保存。",
  "SSH 主机密钥变更会被视为高风险事件，确认前不应继续连接。",
  "本机配置、日志和导出文件由当前操作系统账户保护，请妥善管理设备访问权限。",
];

export function ApplicationSettings() {
  const { error, loading, metadata } = useAppMetadata();
  const pendingLabel = loading ? "正在读取…" : "不可用";
  const availableUpdateRef = useRef<Update | null>(null);
  const downloadedBytesRef = useRef(0);
  const totalBytesRef = useRef<number | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>(initialUpdateState);
  const updateBusy = updateState.phase === "checking" || updateState.phase === "downloading" || updateState.phase === "installing";

  const checkForUpdates = async () => {
    if (updateBusy) {
      return;
    }

    setUpdateState({ ...initialUpdateState, message: "正在检查稳定版本…", phase: "checking" });

    try {
      if (availableUpdateRef.current) {
        await availableUpdateRef.current.close();
        availableUpdateRef.current = null;
      }

      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 20_000 });

      if (!update) {
        setUpdateState({
          ...initialUpdateState,
          message: `当前 ${metadata?.version ?? "安装版本"} 已是最新稳定版。`,
          phase: "current",
        });
        return;
      }

      availableUpdateRef.current = update;
      setUpdateState({
        ...initialUpdateState,
        message: `发现 Portiva ${update.version}，可下载并安装。`,
        phase: "available",
        releaseNotes: update.body?.trim() || null,
        version: update.version,
      });
    } catch {
      setUpdateState({
        ...initialUpdateState,
        message: "检查更新失败，请检查网络连接后重试。",
        phase: "error",
      });
    }
  };

  const installAvailableUpdate = async () => {
    const update = availableUpdateRef.current;

    if (!update || updateBusy) {
      return;
    }

    downloadedBytesRef.current = 0;
    totalBytesRef.current = null;
    setUpdateState((current) => ({
      ...current,
      downloadedBytes: 0,
      message: `正在下载 Portiva ${update.version}…`,
      phase: "downloading",
      progress: null,
      totalBytes: null,
    }));

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytesRef.current = event.data.contentLength ?? null;
          setUpdateState((current) => ({ ...current, totalBytes: totalBytesRef.current }));
          return;
        }

        if (event.event === "Progress") {
          downloadedBytesRef.current += event.data.chunkLength;
          const totalBytes = totalBytesRef.current;
          const progress = totalBytes ? Math.min(100, Math.round((downloadedBytesRef.current / totalBytes) * 100)) : null;

          setUpdateState((current) => {
            if (current.progress === progress && progress !== null) {
              return current;
            }
            if (progress === null && downloadedBytesRef.current - current.downloadedBytes < 256 * 1024) {
              return current;
            }
            return {
              ...current,
              downloadedBytes: downloadedBytesRef.current,
              progress,
              totalBytes,
            };
          });
          return;
        }

        setUpdateState((current) => ({
          ...current,
          message: "下载完成，正在校验签名并安装…",
          phase: "installing",
          progress: 100,
        }));
      });

      setUpdateState((current) => ({ ...current, message: "安装完成，正在重启 Portiva…", phase: "installing" }));
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      setUpdateState((current) => ({
        ...current,
        message: "安装更新失败，请检查网络连接后重试。",
        phase: "error",
      }));
    }
  };

  return (
    <section className="settings-panel application-settings">
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="面向本机工作流的多协议终端和连接管理工具。" title="产品信息" />
        <div className="application-info-grid">
          <span>应用</span>
          <strong>{metadata?.name ?? pendingLabel}</strong>
          <span>版本</span>
          <strong>{metadata?.version ?? pendingLabel}</strong>
        </div>
        {error ? <p className="profile-dialog-note danger" role="alert">{error}</p> : null}
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="更新包验证签名后将在后台静默安装，完成时自动重启。" title="软件更新" />
        <div className={`application-update-card is-${updateState.phase}`}>
          <div className="application-update-symbol" aria-hidden="true">
            <Icon name={updateState.phase === "current" ? "check" : "refresh-ccw"} />
          </div>
          <div className="application-update-copy" aria-live="polite">
            <div className="application-update-title">
              <strong>{updateState.version ? `Portiva ${updateState.version}` : "稳定版本通道"}</strong>
              <UpdateStatusTag phase={updateState.phase} />
            </div>
            <span>{updateState.message}</span>
            {updateState.releaseNotes ? <p>{updateState.releaseNotes}</p> : null}
            {updateState.phase === "downloading" || updateState.phase === "installing" ? (
              <div className="application-update-progress">
                <div
                  aria-label="更新下载进度"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={updateState.progress ?? undefined}
                  className={updateState.progress === null ? "indeterminate" : undefined}
                  role="progressbar"
                >
                  <span style={updateState.progress === null ? undefined : { width: `${updateState.progress}%` }} />
                </div>
                <small>{formatDownloadProgress(updateState)}</small>
              </div>
            ) : null}
          </div>
          <div className="application-update-actions">
            {updateState.phase === "available" ? (
              <Button icon="download" onClick={() => void installAvailableUpdate()} tone="primary">
                更新并重启
              </Button>
            ) : (
              <Button disabled={updateBusy} icon="refresh-ccw" onClick={() => void checkForUpdates()} tone="muted">
                {updateState.phase === "checking" ? "正在检查" : "检查更新"}
              </Button>
            )}
          </div>
        </div>
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="Portiva 默认以本机处理和本机保存为边界。" title="隐私声明" />
        <PolicyList items={privacyItems} />
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="使用 Portiva 前请确认你有权访问目标系统。" title="条款声明" />
        <PolicyList items={termsItems} />
      </section>
      <section className="settings-block application-settings-block">
        <SettingsSectionHeader description="连接工具无法替代操作系统和组织安全策略。" title="安全声明" />
        <PolicyList items={securityItems} />
      </section>
    </section>
  );
}

function UpdateStatusTag({ phase }: { phase: UpdatePhase }) {
  if (phase === "available") {
    return <Tag tone="accent">有新版本</Tag>;
  }
  if (phase === "current") {
    return <Tag tone="success">已是最新</Tag>;
  }
  if (phase === "error") {
    return <Tag tone="danger">操作失败</Tag>;
  }
  if (phase === "checking" || phase === "downloading" || phase === "installing") {
    return <Tag tone="warning">处理中</Tag>;
  }
  return <Tag>稳定通道</Tag>;
}

function formatDownloadProgress(state: UpdateState) {
  if (state.phase === "installing") {
    return "正在安装";
  }
  if (state.totalBytes) {
    return `${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)} · ${state.progress ?? 0}%`;
  }
  return state.downloadedBytes ? `已下载 ${formatBytes(state.downloadedBytes)}` : "正在准备下载";
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PolicyList({ items }: { items: string[] }) {
  return (
    <div className="application-policy-list">
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}
