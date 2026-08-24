import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appUpdateCheck, appUpdateDownloadAndInstall } from "../shared/ipc/commands";

export type AppUpdatePhase =
  | "available"
  | "checking"
  | "current"
  | "downloading"
  | "error"
  | "idle"
  | "installing";

export interface AppUpdateState {
  attempt: number | null;
  maxAttempts: number | null;
  message: string | null;
  phase: AppUpdatePhase;
  progress: number | null;
  version: string | null;
}

export interface AppUpdateController {
  busy: boolean;
  checkForUpdates: () => Promise<void>;
  installAvailableUpdate: () => Promise<void>;
  state: AppUpdateState;
}

interface UpdateProgressEvent {
  kind: "started" | "progress" | "finished";
  attempt: number;
  chunkLength: number;
  contentLength: number | null;
  maxAttempts: number;
}

const updateProgressEvent = "portiva://update-progress";

const initialUpdateState: AppUpdateState = {
  attempt: null,
  maxAttempts: null,
  message: null,
  phase: "idle",
  progress: null,
  version: null,
};

export function useAppUpdate(): AppUpdateController {
  const availableUpdateRef = useRef<string | null>(null);
  const downloadedBytesRef = useRef(0);
  const operationRef = useRef<"checking" | "updating" | null>(null);
  const totalBytesRef = useRef<number | null>(null);
  const [state, setState] = useState<AppUpdateState>(initialUpdateState);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<UpdateProgressEvent>(updateProgressEvent, (event) => {
      const progressEvent = event.payload;
      if (progressEvent.kind === "started") {
        downloadedBytesRef.current = 0;
        totalBytesRef.current = progressEvent.contentLength ?? null;
        setState((current) => ({
          ...current,
          attempt: progressEvent.attempt,
          maxAttempts: progressEvent.maxAttempts,
          message: null,
          phase: "downloading",
          progress: null,
        }));
        return;
      }

      if (progressEvent.kind === "progress") {
        if (progressEvent.contentLength) {
          totalBytesRef.current = progressEvent.contentLength;
        }
        downloadedBytesRef.current += progressEvent.chunkLength;
        const totalBytes = totalBytesRef.current;
        const progress = totalBytes
          ? Math.min(100, Math.round((downloadedBytesRef.current / totalBytes) * 100))
          : null;

        setState((current) => current.progress === progress ? current : { ...current, progress });
        return;
      }

      setState((current) => ({
        ...current,
        attempt: progressEvent.attempt,
        maxAttempts: progressEvent.maxAttempts,
        phase: "installing",
        progress: 100,
      }));
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (operationRef.current) {
      return;
    }

    operationRef.current = "checking";
    setState({ ...initialUpdateState, phase: "checking" });

    try {
      availableUpdateRef.current = null;
      const update = await appUpdateCheck();
      if (!update) {
        setState({ ...initialUpdateState, phase: "current" });
        return;
      }

      availableUpdateRef.current = update.version;
      setState({
        ...initialUpdateState,
        phase: "available",
        version: update.version,
      });
    } catch (error) {
      setState({
        ...initialUpdateState,
        message: formatUpdateError(error, "检查更新失败，请稍后重试。"),
        phase: "error",
      });
    } finally {
      operationRef.current = null;
    }
  }, []);

  const installAvailableUpdate = useCallback(async () => {
    const updateVersion = availableUpdateRef.current;
    if (!updateVersion || operationRef.current) {
      return;
    }

    operationRef.current = "updating";
    downloadedBytesRef.current = 0;
    totalBytesRef.current = null;
    setState((current) => ({
      ...current,
      message: null,
      phase: "downloading",
      progress: null,
    }));

    try {
      await appUpdateDownloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setState((current) => ({
        ...current,
        message: formatUpdateError(error, "更新下载或安装失败，请稍后重试。"),
        phase: "error",
      }));
    } finally {
      operationRef.current = null;
    }
  }, []);

  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";

  return useMemo(() => ({
    busy,
    checkForUpdates,
    installAvailableUpdate,
    state,
  }), [busy, checkForUpdates, installAvailableUpdate, state]);
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
