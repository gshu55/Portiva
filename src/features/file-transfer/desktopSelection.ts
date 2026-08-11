export interface DesktopSelectionModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

function isMacDesktop() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

export function isAdditiveDesktopSelection(event: DesktopSelectionModifiers) {
  return isMacDesktop() ? event.metaKey : event.ctrlKey;
}

export function desktopSelectionHint() {
  return isMacDesktop()
    ? "⌘ + 单击追加选择 · Shift + 单击连续选择"
    : "Ctrl + 单击追加选择 · Shift + 单击连续选择";
}
