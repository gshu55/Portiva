import type { ConnectionCapabilities, TunnelRule } from "../../shared/types";
import { tunnelKindLabel } from "../../shared/labels";
import { Icon } from "../../shared/Icon";

interface TunnelPanelProps {
  capabilities: ConnectionCapabilities;
  tunnels: TunnelRule[];
}

export function TunnelPanel({ capabilities, tunnels }: TunnelPanelProps) {
  if (!capabilities.tunnel && !capabilities.portForwarding) {
    return (
      <section className="panel compact">
        <div className="panel-heading">
          <span>隧道</span>
        </div>
        <p>当前协议不可用。</p>
      </section>
    );
  }

  return (
    <section className="panel tunnel-panel">
      <div className="panel-heading">
        <span>隧道</span>
        <small>{tunnels.length}</small>
      </div>
      <div className="tunnel-actions">
        <button aria-label="本地隧道" title="本地隧道" type="button">
          <Icon name="home" />
        </button>
        <button aria-label="远程隧道" title="远程隧道" type="button">
          <Icon name="server" />
        </button>
        <button aria-label="动态隧道" title="动态隧道" type="button">
          <Icon name="network" />
        </button>
      </div>
      <div className="tunnel-list">
        {tunnels.length > 0 ? (
          tunnels.map((tunnel) => (
            <div className="tunnel-row" key={tunnel.id}>
              <span>{tunnelKindLabel(tunnel.kind)}</span>
              <span>
                {tunnel.localHost}:{tunnel.localPort}
              </span>
              <span>
                {tunnel.remoteHost}:{tunnel.remotePort}
              </span>
              <small>{tunnel.status}</small>
            </div>
          ))
        ) : (
          <div className="settings-empty">暂无隧道规则</div>
        )}
      </div>
    </section>
  );
}
