import { useEffect, useMemo, useState } from "react";
import type { NetworkScanRequest } from "../../shared/types";
import { NetworkScanControls } from "./NetworkScanControls";
import { NetworkScanResults } from "./NetworkScanResults";
import { NetworkScanSummary } from "./NetworkScanSummary";
import {
  defaultNetworkScanDraft,
  parsePortList,
  parseScanLimits,
  type NetworkScanDraft,
} from "./networkScanConfig";
import { useNetworkScanner } from "./useNetworkScanner";
import "./networkScanner.css";

interface NetworkScannerPanelProps {
  onCreateProfile: (host: string, port: number) => void;
}

export function NetworkScannerPanel({ onCreateProfile }: NetworkScannerPanelProps) {
  const scanner = useNetworkScanner();
  const [draft, setDraft] = useState<NetworkScanDraft>(defaultNetworkScanDraft);
  const [selectedInterface, setSelectedInterface] = useState("");
  const [validationError, setValidationError] = useState<string>();
  const busy = ["starting", "running", "cancelling"].includes(scanner.status);

  useEffect(() => {
    if (draft.cidr || !scanner.interfaces.length) {
      return;
    }
    const preferred = scanner.interfaces.find((item) => item.isPrivate && !item.isLoopback)
      ?? scanner.interfaces.find((item) => !item.isLoopback)
      ?? scanner.interfaces[0];
    setSelectedInterface(`${preferred.name}|${preferred.address}`);
    setDraft((current) => ({ ...current, cidr: preferred.cidr }));
  }, [draft.cidr, scanner.interfaces]);

  const interfaceByKey = useMemo(
    () => new Map(scanner.interfaces.map((item) => [`${item.name}|${item.address}`, item])),
    [scanner.interfaces],
  );

  const updateDraft = (patch: Partial<NetworkScanDraft>) => {
    setValidationError(undefined);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const selectInterface = (value: string) => {
    setSelectedInterface(value);
    const networkInterface = interfaceByKey.get(value);
    if (networkInterface) {
      updateDraft({ cidr: networkInterface.cidr });
    }
  };

  const startScan = async () => {
    const cidr = draft.cidr.trim();
    if (!cidr) {
      setValidationError("请输入要扫描的 IPv4 CIDR 网段");
      return;
    }
    if (!draft.pingEnabled && !draft.tcpEnabled) {
      setValidationError("请至少启用 Ping 或 TCP 探测中的一种");
      return;
    }

    const scanLimits = parseScanLimits(draft.timeoutMs, draft.concurrency);
    if (scanLimits.error) {
      setValidationError(scanLimits.error);
      return;
    }

    const parsedPorts = parsePortList(draft.portsText);
    if (draft.tcpEnabled && parsedPorts.error) {
      setValidationError(parsedPorts.error);
      return;
    }
    if (draft.tcpEnabled && parsedPorts.ports.length === 0) {
      setValidationError("启用 TCP 探测时至少需要一个端口");
      return;
    }

    const request: NetworkScanRequest = {
      cidr,
      concurrency: scanLimits.concurrency,
      pingEnabled: draft.pingEnabled,
      ports: parsedPorts.ports,
      tcpEnabled: draft.tcpEnabled,
      timeoutMs: scanLimits.timeoutMs,
    };
    await scanner.start(request);
  };

  const total = scanner.session?.total ?? 0;
  const visibleError = validationError ?? scanner.error ?? undefined;

  return (
    <section className="network-scanner" aria-label="局域网扫描">
      <div className="network-scan-layout">
        <NetworkScanControls
          busy={busy}
          draft={draft}
          interfaces={scanner.interfaces}
          interfacesLoading={scanner.interfacesLoading}
          selectedInterface={selectedInterface}
          validationError={visibleError}
          onCancel={() => void scanner.cancel()}
          onChange={updateDraft}
          onInterfaceChange={selectInterface}
          onRefreshInterfaces={() => void scanner.refreshInterfaces()}
          onStart={() => void startScan()}
        />
        <main className="network-scan-main">
          <NetworkScanSummary
            results={scanner.results}
            scanned={scanner.scanned}
            status={scanner.status}
            total={total}
          />
          <NetworkScanResults
            results={scanner.results}
            status={scanner.status}
            onCreateProfile={onCreateProfile}
          />
        </main>
      </div>
    </section>
  );
}
