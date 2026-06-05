type ShortcutSpec = {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  key: string;
};

const modifierAliases: Record<string, keyof Omit<ShortcutSpec, "key">> = {
  alt: "alt",
  option: "alt",
  cmd: "meta",
  command: "meta",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  shift: "shift",
};

export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const spec = parseShortcut(shortcut);

  if (!spec) {
    return false;
  }

  return (
    event.altKey === spec.alt &&
    event.ctrlKey === spec.ctrl &&
    event.metaKey === spec.meta &&
    event.shiftKey === spec.shift &&
    normalizeKey(event.key) === spec.key
  );
}

export function parseShortcut(shortcut: string): ShortcutSpec | null {
  const tokens = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  const spec: ShortcutSpec = {
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
    key: "",
  };

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    const modifier = modifierAliases[normalized];

    if (modifier) {
      spec[modifier] = true;
      continue;
    }

    if (spec.key) {
      return null;
    }

    spec.key = normalizeKey(token);
  }

  return spec.key ? spec : null;
}

export function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function normalizeKey(key: string) {
  const normalized = key.trim().toLowerCase();

  if (normalized === "esc") {
    return "escape";
  }

  if (normalized === "space") {
    return " ";
  }

  return normalized;
}
