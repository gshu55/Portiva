import { KeymapSettings } from "./KeymapSettings";
import { NetworkSettings } from "./NetworkSettings";
import { TerminalSettings } from "./TerminalSettings";
import { ThemeSettings } from "./ThemeSettings";
import type { AppSettings } from "../../shared/types";

export type SettingsSectionId = "theme" | "terminal" | "network" | "keymap";

interface SettingsPanelProps {
  section: SettingsSectionId;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
}

export function SettingsPanel({
  onSaveSettings,
  section,
  settings,
}: SettingsPanelProps) {
  return (
    <section className="panel settings-panel">
      {section === "theme" ? <ThemeSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "terminal" ? (
        <TerminalSettings settings={settings} onSaveSettings={onSaveSettings} />
      ) : null}
      {section === "network" ? (
        <NetworkSettings settings={settings} onSaveSettings={onSaveSettings} />
      ) : null}
      {section === "keymap" ? <KeymapSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
    </section>
  );
}
