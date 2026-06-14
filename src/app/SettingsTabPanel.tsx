import { SettingsPage } from "../features/settings/SettingsPage";
import type { usePortivaWorkspace } from "./usePortivaWorkspace";

interface SettingsTabPanelProps {
  workspace: ReturnType<typeof usePortivaWorkspace>;
}

export function SettingsTabPanel({ workspace }: SettingsTabPanelProps) {
  return (
    <SettingsPage
      knownHosts={workspace.knownHosts}
      redactionInput={workspace.redactionInput}
      redactionPreview={workspace.redactionPreview}
      secrets={workspace.secrets}
      settings={workspace.settings}
      onDeleteKnownHost={workspace.deleteKnownHost}
      onDeleteSecretMetadata={workspace.deleteSecretMetadata}
      onPreviewRedaction={workspace.previewRedaction}
      onRedactionInputChange={workspace.setRedactionInput}
      onSaveSettings={workspace.saveSettings}
    />
  );
}
