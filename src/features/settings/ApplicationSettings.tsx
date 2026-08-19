import { useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appUpdateCheck, appUpdateDownloadAndInstall } from "../../shared/ipc/commands";
import { Button } from "../../shared/ui";
import { useAppMetadata } from "../../shared/useAppMetadata";
import { SettingsSectionHeader } from "./SettingsSection";

type UpdatePhase = "available" | "checking" | "current" | "downloading" | "error" | "idle" | "installing";

interface UpdateState {
  attempt: number | null;
  maxAttempts: number | null;
  message: string | null;
  phase: UpdatePhase;
  progress: number | null;
  version: string | null;
}

interface UpdateProgressEvent {
  kind: "started" | "progress" | "finished";
  attempt: number;
  chunkLength: number;
  contentLength: number | null;
  maxAttempts: number;
}

const initialUpdateState: UpdateState = {
  attempt: null,
  maxAttempts: null,
  message: null,
  phase: "idle",
  progress: null,
  version: null,
};

const legalResources: Array<{
  title: string;
  url: string;
}> = [
  {
    title: "隐私声明",
    url: "https://github.com/gshu55/Portiva/blob/main/docs/legal/privacy.md",
  },
  {
    title: "条款声明",
    url: "https://github.com/gshu55/Portiva/blob/main/docs/legal/terms.md",
  },
  {
    title: "安全声明",
    url: "https://github.com/gshu55/Portiva/blob/main/docs/legal/security.md",
  },
];

export function ApplicationSettings() {
  const { loading, metadata } = useAppMetadata();
  const availableUpdateRef = useRef<string | null>(null);
  const downloadedBytesRef = useRef(0);
  const totalBytesRef = useRef<number | null>(null);
  const [externalLinkError, setExternalLinkError] = useState("");
  const [updateState, setUpdateState] = useState<UpdateState>(initialUpdateState);
  const updateBusy = updateState.phase === "checking" || updateState.phase === "downloading" || updateState.phase === "installing";

  const checkForUpdates = async () => {
    if (updateBusy) {
      return;
    }

    setUpdateState({ ...initialUpdateState, phase: "checking" });

    try {
      availableUpdateRef.current = null;
      const update = await appUpdateCheck();

      if (!update) {
        setUpdateState({ ...initialUpdateState, phase: "current" });
        return;
      }

      availableUpdateRef.current = update.version;
      setUpdateState({
        ...initialUpdateState,
        phase: "available",
        version: update.version,
      });
    } catch (error) {
      setUpdateState({
        ...initialUpdateState,
        message: formatUpdateError(error, "检查更新失败，请稍后重试。"),
        phase: "error",
      });
    }
  };

  const installAvailableUpdate = async () => {
    const updateVersion = availableUpdateRef.current;

    if (!updateVersion || updateBusy) {
      return;
    }

    downloadedBytesRef.current = 0;
    totalBytesRef.current = null;
    setUpdateState((current) => ({
      ...current,
      phase: "downloading",
      progress: null,
    }));

    try {
      const unlisten = await listen<UpdateProgressEvent>("portiva://update-progress", (event) => {
        if (event.payload.kind === "started") {
          downloadedBytesRef.current = 0;
          totalBytesRef.current = event.payload.contentLength ?? null;
          setUpdateState((current) => ({
            ...current,
            attempt: event.payload.attempt,
            maxAttempts: event.payload.maxAttempts,
            message: null,
            phase: "downloading",
            progress: null,
          }));
          return;
        }

        if (event.payload.kind === "progress") {
          if (event.payload.contentLength) {
            totalBytesRef.current = event.payload.contentLength;
          }
          downloadedBytesRef.current += event.payload.chunkLength;
          const totalBytes = totalBytesRef.current;
          const progress = totalBytes ? Math.min(100, Math.round((downloadedBytesRef.current / totalBytes) * 100)) : null;

          setUpdateState((current) => {
            if (current.progress === progress) {
              return current;
            }
            return { ...current, progress };
          });
          return;
        }

        setUpdateState((current) => ({
          ...current,
          attempt: event.payload.attempt,
          maxAttempts: event.payload.maxAttempts,
          phase: "installing",
          progress: 100,
        }));
      });
      try {
        await appUpdateDownloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } finally {
        unlisten();
      }
    } catch (error) {
      setUpdateState((current) => ({
        ...current,
        message: formatUpdateError(error, "更新下载或安装失败，请稍后重试。"),
        phase: "error",
      }));
    }
  };

  const openExternalResource = async (url: string) => {
    setExternalLinkError("");
    try {
      await openUrl(url);
    } catch {
      setExternalLinkError("无法打开默认浏览器，请稍后重试。");
    }
  };

  const updateButtonLabel = getUpdateButtonLabel(updateState);
  const canRetryDownload = updateState.phase === "error" && Boolean(updateState.version);
  const updateAction = updateState.phase === "available" || canRetryDownload
    ? installAvailableUpdate
    : checkForUpdates;
  const updateDisabled = updateBusy || updateState.phase === "current";

  return (
    <section className="settings-panel application-settings">
      <section className="settings-block application-settings-block application-summary-block">
        <div className="application-summary">
          <div className="application-product">
            <strong>{metadata?.name ?? "Portiva"}</strong>
            {loading || metadata?.version ? <span>{loading ? "…" : `v${metadata?.version}`}</span> : null}
          </div>
          <Button
            aria-live="polite"
            className="application-update-button"
            disabled={updateDisabled}
            onClick={() => void updateAction()}
            tone={updateState.phase === "available" || canRetryDownload ? "primary" : "muted"}
          >
            {updateButtonLabel}
          </Button>
        </div>
        {updateState.message ? (
          <p className="application-update-error profile-dialog-note danger" role="alert">
            {updateState.message}
          </p>
        ) : null}
      </section>
      <section className="settings-block application-settings-block application-resources-block">
        <SettingsSectionHeader title="相关声明" />
        <div className="application-resource-links">
          {legalResources.map((resource) => (
            <button
              className="application-resource-link"
              key={resource.title}
              onClick={() => void openExternalResource(resource.url)}
              type="button"
            >
              {resource.title}
            </button>
          ))}
        </div>
        {externalLinkError ? <p className="profile-dialog-note danger" role="alert">{externalLinkError}</p> : null}
      </section>
    </section>
  );
}

function getUpdateButtonLabel(state: UpdateState) {
  switch (state.phase) {
    case "checking":
      return "正在检查";
    case "current":
      return "已是最新";
    case "available":
      return state.version ? `更新至 v${state.version}` : "安装更新";
    case "downloading":
      if (state.attempt && state.attempt > 1) {
        const attempt = state.maxAttempts ? `${state.attempt}/${state.maxAttempts}` : String(state.attempt);
        return state.progress === null ? `重试下载 ${attempt}` : `重试 ${attempt} · ${state.progress}%`;
      }
      return state.progress === null ? "正在下载" : `下载中 ${state.progress}%`;
    case "installing":
      return "正在安装";
    case "error":
      return state.version ? "重试下载" : "重试检查";
    default:
      return "检查更新";
  }
}

function formatUpdateError(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}
