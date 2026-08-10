import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  networkScanCancel,
  networkScanInterfaces,
  networkScanStart,
} from "../../shared/ipc/commands";
import type {
  NetworkInterfaceInfo,
  NetworkScanEvent,
  NetworkScanRequest,
  NetworkScanResult,
  NetworkScanSession,
} from "../../shared/types";

export const networkScanEventName = "portiva://network-scan-event";

export type NetworkScannerStatus =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export function useNetworkScanner() {
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([]);
  const [interfacesLoading, setInterfacesLoading] = useState(true);
  const [session, setSession] = useState<NetworkScanSession | null>(null);
  const [status, setStatus] = useState<NetworkScannerStatus>("idle");
  const [results, setResults] = useState<NetworkScanResult[]>([]);
  const [scanned, setScanned] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const activeScanIdRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const queuedEventsRef = useRef<NetworkScanEvent[]>([]);

  const applyEvent = useCallback((event: NetworkScanEvent) => {
    setScanned(event.scanned);
    if (event.results.length) {
      setResults((current) => [...current, ...event.results]);
      const probeError = event.results.find((result) => result.error)?.error;
      if (probeError) {
        setError(probeError);
      }
    }

    if (event.kind === "completed") {
      activeScanIdRef.current = null;
      setStatus("completed");
    } else if (event.kind === "cancelled") {
      activeScanIdRef.current = null;
      setStatus("cancelled");
    }
  }, []);

  const refreshInterfaces = useCallback(async () => {
    setInterfacesLoading(true);
    try {
      setInterfaces(await networkScanInterfaces());
    } catch (refreshError) {
      setError(`读取网络接口失败：${String(refreshError)}`);
    } finally {
      setInterfacesLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshInterfaces();
  }, [refreshInterfaces]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<NetworkScanEvent>(networkScanEventName, ({ payload }) => {
      const activeScanId = activeScanIdRef.current;
      if (!activeScanId) {
        if (startingRef.current) {
          queuedEventsRef.current.push(payload);
        }
        return;
      }
      if (payload.scanId === activeScanId) {
        applyEvent(payload);
      }
    }).then((dispose) => {
      if (disposed) {
        void dispose();
      } else {
        unlisten = dispose;
      }
    }).catch(() => {
      setError("当前环境无法监听网络扫描事件，请在 Portiva 桌面应用中使用此功能");
    });

    return () => {
      disposed = true;
      unlisten?.();
      const activeScanId = activeScanIdRef.current;
      if (activeScanId) {
        void networkScanCancel(activeScanId);
      }
    };
  }, [applyEvent]);

  const start = useCallback(async (request: NetworkScanRequest) => {
    setError(null);
    setResults([]);
    setScanned(0);
    setSession(null);
    setStatus("starting");
    startingRef.current = true;
    queuedEventsRef.current = [];

    try {
      const nextSession = await networkScanStart(request);
      activeScanIdRef.current = nextSession.scanId;
      setSession(nextSession);
      setStatus("running");

      const queuedEvents = queuedEventsRef.current;
      queuedEventsRef.current = [];
      queuedEvents
        .filter((event) => event.scanId === nextSession.scanId)
        .forEach(applyEvent);
      return true;
    } catch (startError) {
      setError(String(startError));
      setStatus("failed");
      return false;
    } finally {
      startingRef.current = false;
    }
  }, [applyEvent]);

  const cancel = useCallback(async () => {
    const scanId = activeScanIdRef.current;
    if (!scanId) {
      return;
    }
    setStatus("cancelling");
    try {
      const cancellationAccepted = await networkScanCancel(scanId);
      if (!cancellationAccepted) {
        activeScanIdRef.current = null;
        setStatus("cancelled");
      }
    } catch (cancelError) {
      setError(`停止扫描失败：${String(cancelError)}`);
      setStatus("running");
    }
  }, []);

  return {
    cancel,
    error,
    interfaces,
    interfacesLoading,
    refreshInterfaces,
    results,
    scanned,
    session,
    start,
    status,
  };
}
