import { enabledCapabilityNames } from "../../shared/capabilities";
import { capabilityLabel } from "../../shared/labels";
import type { ProtocolDescriptor } from "../../shared/types";

interface ProtocolMatrixProps {
  protocols: ProtocolDescriptor[];
}

export function ProtocolMatrix({ protocols }: ProtocolMatrixProps) {
  return (
    <section className="panel protocol-matrix">
      <div className="panel-heading">
        <span>协议注册表</span>
        <small>{protocols.length}</small>
      </div>
      <div className="protocol-grid">
        {protocols.map((protocol) => (
          <div className="protocol-card" key={protocol.protocolType}>
            <div className="protocol-card-title">
              <strong>{protocol.label}</strong>
              <span>{protocol.enabled ? "已启用" : "待实现"}</span>
            </div>
            <div className="protocol-caps">
              {enabledCapabilityNames(protocol.capabilities).map((capability) => (
                <small key={capability}>{capabilityLabel(capability)}</small>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
