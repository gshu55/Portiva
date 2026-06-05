import type { ProfileGroup, RecentConnection } from "../../shared/types";

interface ConnectionLauncherProps {
  groups: ProfileGroup[];
  recentConnections: RecentConnection[];
}

export function ConnectionLauncher({ groups, recentConnections }: ConnectionLauncherProps) {
  return (
    <section className="panel connection-launcher">
      <div className="panel-heading">
        <span>启动器</span>
        <small>{groups.length} 组</small>
      </div>
      <div className="launcher-section">
        <strong>分组</strong>
        {groups.length > 0 ? (
          groups.map((group) => (
            <div className="launcher-row" key={group.id}>
              <span>{group.name}</span>
              <small>{group.profileCount}</small>
            </div>
          ))
        ) : (
          <div className="settings-empty">暂无分组</div>
        )}
      </div>
      <div className="launcher-section">
        <strong>最近</strong>
        {recentConnections.length > 0 ? (
          recentConnections.map((recent) => (
            <div className="launcher-row" key={recent.profileId}>
              <span>{recent.title}</span>
              <small>{recent.lastConnectedAt.slice(0, 10)}</small>
            </div>
          ))
        ) : (
          <div className="settings-empty">暂无最近连接</div>
        )}
      </div>
    </section>
  );
}
