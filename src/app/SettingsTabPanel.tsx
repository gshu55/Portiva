import { SettingsPage } from "../features/settings/SettingsPage";
import type { usePortivaWorkspace } from "./usePortivaWorkspace";
import type { AppUpdateController } from "./useAppUpdate";

interface SettingsTabPanelProps {
  appUpdate: AppUpdateController;
  workspace: ReturnType<typeof usePortivaWorkspace>;
}

export function SettingsTabPanel({ appUpdate, workspace }: SettingsTabPanelProps) {
  return (
    <SettingsPage
      appUpdate={appUpdate}
      settings={workspace.settings}
      onSaveSettings={workspace.saveSettings}
    />
  );
}
