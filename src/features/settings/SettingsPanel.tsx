import { KeymapSettings } from "./KeymapSettings";
import { SecuritySettings } from "./SecuritySettings";
import { TerminalPaletteSettings } from "./TerminalPaletteSettings";
import { TerminalSettings } from "./TerminalSettings";
import { ThemeSettings } from "./ThemeSettings";
import type { AppSettings, KnownHostEntry, SecretMetadata } from "../../shared/types";

export type SettingsSectionId = "theme" | "terminal-palette" | "terminal" | "keymap" | "security";

interface SettingsPanelProps {
  section: SettingsSectionId;
  knownHosts: KnownHostEntry[];
  redactionInput: string;
  redactionPreview: string;
  secrets: SecretMetadata[];
  settings: AppSettings;
  onDeleteSecretMetadata: (secretId: string) => void;
  onDeleteKnownHost: (host: string) => void;
  onPreviewRedaction: () => void;
  onRedactionInputChange: (value: string) => void;
  onSaveSettings: (settings: AppSettings) => void;
}

export function SettingsPanel({
  knownHosts,
  onPreviewRedaction,
  onDeleteSecretMetadata,
  onDeleteKnownHost,
  onRedactionInputChange,
  onSaveSettings,
  redactionInput,
  redactionPreview,
  section,
  secrets,
  settings,
}: SettingsPanelProps) {
  return (
    <section className="panel settings-panel">
      {section === "theme" ? <ThemeSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "terminal-palette" ? <TerminalPaletteSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "terminal" ? <TerminalSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "keymap" ? <KeymapSettings settings={settings} onSaveSettings={onSaveSettings} /> : null}
      {section === "security" ? (
        <SecuritySettings
          knownHosts={knownHosts}
          redactionInput={redactionInput}
          redactionPreview={redactionPreview}
          secrets={secrets}
          settings={settings}
          onDeleteSecretMetadata={onDeleteSecretMetadata}
          onDeleteKnownHost={onDeleteKnownHost}
          onPreviewRedaction={onPreviewRedaction}
          onRedactionInputChange={onRedactionInputChange}
          onSaveSettings={onSaveSettings}
        />
      ) : null}
    </section>
  );
}
