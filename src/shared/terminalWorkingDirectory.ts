const osc7SequencePattern = /\u001B\]7;([^\u0007\u001B]*)(?:\u0007|\u001B\\)/g;
const maximumWorkingDirectoryLength = 8192;

export function parseOsc7WorkingDirectory(value: string) {
  const uri = value.trim();

  if (!uri || uri.length > maximumWorkingDirectoryLength) {
    return "";
  }

  try {
    const location = new URL(uri);

    if (location.protocol !== "file:") {
      return "";
    }

    return normalizeOscPath(safeDecodePath(location.pathname));
  } catch {
    return uri.startsWith("/") ? normalizeOscPath(safeDecodePath(uri)) : "";
  }
}

export function latestOsc7WorkingDirectory(text: string) {
  let latestPath = "";

  for (const match of text.matchAll(osc7SequencePattern)) {
    const path = parseOsc7WorkingDirectory(match[1] ?? "");

    if (path) {
      latestPath = path;
    }
  }

  return latestPath;
}

function safeDecodePath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizeOscPath(path: string) {
  if (!path.startsWith("/") || /[\u0000-\u001F\u007F]/.test(path)) {
    return "";
  }

  const parts: string[] = [];

  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return parts.length ? `/${parts.join("/")}` : "/";
}
