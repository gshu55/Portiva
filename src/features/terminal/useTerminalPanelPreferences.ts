import { useEffect, useState } from "react";

const storageKey = "portiva:terminal-panel-preferences:v1";

export interface TerminalPanelPreferences {
  command: boolean;
  sftp: boolean;
  status: boolean;
}

const defaults: TerminalPanelPreferences = { command: false, sftp: true, status: false };

export function readTerminalPanelPreferences(): TerminalPanelPreferences {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (!value || typeof value !== "object") {
      return { ...defaults };
    }
    return {
      command: "command" in value && typeof value.command === "boolean" ? value.command : defaults.command,
      sftp: "sftp" in value && typeof value.sftp === "boolean" ? value.sftp : defaults.sftp,
      status: "status" in value && typeof value.status === "boolean" ? value.status : defaults.status,
    };
  } catch {
    return { ...defaults };
  }
}

export function writeTerminalPanelPreferences(preferences: TerminalPanelPreferences) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Keep panel controls usable when local storage is unavailable.
  }
}

export function useTerminalPanelPreferences() {
  const [preferences, setPreferences] = useState(readTerminalPanelPreferences);

  useEffect(() => {
    writeTerminalPanelPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    const syncPreferences = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) {
        setPreferences(readTerminalPanelPreferences());
      }
    };
    window.addEventListener("storage", syncPreferences);
    return () => window.removeEventListener("storage", syncPreferences);
  }, []);

  return [preferences, setPreferences] as const;
}
