import { useCallback, useEffect, useState } from "react";

const savedCommandsStorageKey = "portiva:ssh-saved-commands:v1";
const maximumSavedCommands = 100;

export interface SavedSshCommand {
  command: string;
  id: string;
  updatedAt: number;
}

function readSavedCommands() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const value = JSON.parse(window.localStorage.getItem(savedCommandsStorageKey) ?? "[]") as unknown;
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter(
        (item): item is SavedSshCommand =>
          Boolean(
            item &&
              typeof item === "object" &&
              "id" in item &&
              typeof item.id === "string" &&
              "command" in item &&
              typeof item.command === "string" &&
              item.command.trim() &&
              "updatedAt" in item &&
              typeof item.updatedAt === "number",
          ),
      )
      .slice(0, maximumSavedCommands);
  } catch {
    return [];
  }
}

function commandId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `command-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useSavedSshCommands() {
  const [commands, setCommands] = useState<SavedSshCommand[]>(readSavedCommands);

  useEffect(() => {
    try {
      window.localStorage.setItem(savedCommandsStorageKey, JSON.stringify(commands));
    } catch {
      // The command library remains available for this window when storage is unavailable.
    }
  }, [commands]);

  useEffect(() => {
    const syncCommands = (event: StorageEvent) => {
      if (event.key === savedCommandsStorageKey) {
        setCommands(readSavedCommands());
      }
    };

    window.addEventListener("storage", syncCommands);
    return () => window.removeEventListener("storage", syncCommands);
  }, []);

  const addCommand = useCallback((value: string) => {
    const command = value.trim();
    if (!command) {
      return;
    }

    setCommands((current) => {
      const existing = current.find((item) => item.command === command);
      const next = existing
        ? [{ ...existing, updatedAt: Date.now() }, ...current.filter((item) => item.id !== existing.id)]
        : [{ command, id: commandId(), updatedAt: Date.now() }, ...current];
      return next.slice(0, maximumSavedCommands);
    });
  }, []);

  const updateCommand = useCallback((commandIdValue: string, value: string) => {
    const command = value.trim();
    if (!command) {
      return;
    }

    setCommands((current) =>
      current.map((item) =>
        item.id === commandIdValue ? { ...item, command, updatedAt: Date.now() } : item,
      ),
    );
  }, []);

  const removeCommand = useCallback((commandIdValue: string) => {
    setCommands((current) => current.filter((item) => item.id !== commandIdValue));
  }, []);

  return { addCommand, commands, removeCommand, updateCommand };
}
