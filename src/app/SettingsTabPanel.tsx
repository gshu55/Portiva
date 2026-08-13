import { SettingsPage } from "../features/settings/SettingsPage";
import type { usePortivaWorkspace } from "./usePortivaWorkspace";

interface SettingsTabPanelProps {
  workspace: ReturnType<typeof usePortivaWorkspace>;
}

export function SettingsTabPanel({ workspace }: SettingsTabPanelProps) {
  return (
    <SettingsPage
      settings={workspace.settings}
      onSaveSettings={workspace.saveSettings}
    />
  );
}
