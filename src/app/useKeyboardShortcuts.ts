import { useEffect } from "react";
import { isEditableShortcutTarget, matchesShortcut } from "../shared/keymap";
import type { AppSettings } from "../shared/types";

interface ShortcutHandlers {
  onCloseTab: () => void;
  onNewProfile: () => void;
  onOpenLocalTerminal: () => void;
  onOpenSerialTerminal: () => void;
}

export function useKeyboardShortcuts(settings: AppSettings, handlers: ShortcutHandlers) {
  useEffect(() => {
    const keymap = settings.keymap;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isBrowserReloadShortcut(event)) {
        if (isTerminalCtrlR(event)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (isEditableShortcutTarget(event.target)) {
        return;
      }

      const shortcutCommands: Array<[string, () => void]> = [
        [keymap.newProfile || "Ctrl+N", handlers.onNewProfile],
        [keymap.openLocalTerminal || "Ctrl+Alt+T", handlers.onOpenLocalTerminal],
        [keymap.openSerialTerminal || "Ctrl+Alt+S", handlers.onOpenSerialTerminal],
        [keymap.closeTab || "Ctrl+W", handlers.onCloseTab],
      ];
      const command = shortcutCommands.find(([shortcut]) => matchesShortcut(event, shortcut));

      if (!command) {
        return;
      }

      event.preventDefault();
      command[1]();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [handlers, settings]);
}

function isBrowserReloadShortcut(event: KeyboardEvent) {
  if (event.key === "F5") {
    return true;
  }

  const key = event.key.toLowerCase();
  return key === "r" && (event.ctrlKey || event.metaKey);
}

function isTerminalCtrlR(event: KeyboardEvent) {
  if (
    event.key.toLowerCase() !== "r" ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return false;
  }

  return event.target instanceof HTMLElement && Boolean(event.target.closest(".xterm"));
}
