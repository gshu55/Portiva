import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppUpdateController, AppUpdateState } from "../../app/useAppUpdate";
import { Button } from "../../shared/ui";
import { useAppMetadata } from "../../shared/useAppMetadata";
import { SettingsSectionHeader } from "./SettingsSection";

interface ApplicationSettingsProps {
  appUpdate: AppUpdateController;
}

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

export function ApplicationSettings({ appUpdate }: ApplicationSettingsProps) {
  const { loading, metadata } = useAppMetadata();
  const [externalLinkError, setExternalLinkError] = useState("");
  const { busy: updateBusy, checkForUpdates, installAvailableUpdate, state: updateState } = appUpdate;

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

function getUpdateButtonLabel(state: AppUpdateState) {
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
