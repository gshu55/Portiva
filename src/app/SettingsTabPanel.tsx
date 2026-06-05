import { SettingsPage } from "../features/settings/SettingsPage";
import type { usePortivaWorkspace } from "./usePortivaWorkspace";

interface SettingsTabPanelProps {
  workspace: ReturnType<typeof usePortivaWorkspace>;
}

export function SettingsTabPanel({ workspace }: SettingsTabPanelProps) {
  return (
    <SettingsPage
      capabilities={workspace.capabilities}
      connection={workspace.activeConnection}
      groups={workspace.groups}
      knownHosts={workspace.knownHosts}
      logs={workspace.logs}
      message={workspace.workspaceMessage}
      protocolDescriptors={workspace.protocolDescriptors}
      recentConnections={workspace.recentConnections}
      redactionInput={workspace.redactionInput}
      redactionPreview={workspace.redactionPreview}
      secrets={workspace.secrets}
      settings={workspace.settings}
      tunnels={workspace.tunnels}
      onClearLogs={workspace.clearLogs}
      onDeleteKnownHost={workspace.deleteKnownHost}
      onDeleteSecretMetadata={workspace.deleteSecretMetadata}
      onPreviewRedaction={workspace.previewRedaction}
      onRedactionInputChange={workspace.setRedactionInput}
      onSaveSettings={workspace.saveSettings}
    />
  );
}
