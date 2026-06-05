import { useEffect } from "react";
import { isEditableShortcutTarget, matchesShortcut } from "../shared/keymap";
import type { AppSettings } from "../shared/types";

interface ShortcutHandlers {
  onCloseTab: () => void;
  onNewProfile: () => void;
}

export function useKeyboardShortcuts(settings: AppSettings, handlers: ShortcutHandlers) {
  useEffect(() => {
    const keymap = settings.keymap;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isBrowserReloadShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (isEditableShortcutTarget(event.target)) {
        return;
      }

      const command =
        matchesShortcut(event, keymap.newProfile)
          ? handlers.onNewProfile
          : matchesShortcut(event, keymap.closeTab)
              ? handlers.onCloseTab
              : null;

      if (!command) {
        return;
      }

      event.preventDefault();
      command();
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
