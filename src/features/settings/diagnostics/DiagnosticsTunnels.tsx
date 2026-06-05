import { TunnelPanel } from "../../tunnels/TunnelPanel";
import type { ConnectionCapabilities, TunnelRule } from "../../../shared/types";

interface DiagnosticsTunnelsProps {
  capabilities: ConnectionCapabilities;
  tunnels: TunnelRule[];
}

export function DiagnosticsTunnels({ capabilities, tunnels }: DiagnosticsTunnelsProps) {
  return (
    <section className="diagnostics-panel">
      <TunnelPanel capabilities={capabilities} tunnels={tunnels} />
    </section>
  );
}
