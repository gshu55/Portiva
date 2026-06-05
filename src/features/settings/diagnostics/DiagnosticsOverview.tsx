import { ConnectionLauncher } from "../../connections/ConnectionLauncher";
import type { ProfileGroup, RecentConnection } from "../../../shared/types";

interface DiagnosticsOverviewProps {
  groups: ProfileGroup[];
  recentConnections: RecentConnection[];
}

export function DiagnosticsOverview({ groups, recentConnections }: DiagnosticsOverviewProps) {
  return (
    <section className="diagnostics-panel diagnostics-overview">
      <ConnectionLauncher groups={groups} recentConnections={recentConnections} />
    </section>
  );
}
