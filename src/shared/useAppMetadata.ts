import { getName, getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

export interface AppMetadata {
  name: string;
  version: string;
}

interface AppMetadataState {
  error: string | null;
  loading: boolean;
  metadata: AppMetadata | null;
}

let appMetadataRequest: Promise<AppMetadata> | null = null;

function readAppMetadata() {
  if (!appMetadataRequest) {
    appMetadataRequest = Promise.all([getName(), getVersion()])
      .then(([name, version]) => ({ name, version }))
      .catch((error) => {
        appMetadataRequest = null;
        throw error;
      });
  }

  return appMetadataRequest;
}

export function useAppMetadata(): AppMetadataState {
  const [state, setState] = useState<AppMetadataState>({
    error: null,
    loading: true,
    metadata: null,
  });

  useEffect(() => {
    let cancelled = false;

    void readAppMetadata()
      .then((metadata) => {
        if (!cancelled) {
          setState({ error: null, loading: false, metadata });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            error: `读取应用信息失败：${String(error)}`,
            loading: false,
            metadata: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
