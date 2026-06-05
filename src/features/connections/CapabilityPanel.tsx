import { enabledCapabilityNames } from "../../shared/capabilities";
import { capabilityLabel } from "../../shared/labels";
import type { ConnectionCapabilities } from "../../shared/types";

interface CapabilityPanelProps {
  capabilities: ConnectionCapabilities;
}

export function CapabilityPanel({ capabilities }: CapabilityPanelProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <span>能力</span>
      </div>
      <div className="capability-list">
        {enabledCapabilityNames(capabilities).map((capability) => (
          <span key={capability}>{capabilityLabel(capability)}</span>
        ))}
      </div>
    </section>
  );
}
