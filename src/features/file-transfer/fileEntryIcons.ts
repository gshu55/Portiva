import type { IconName } from "../../shared/Icon";
import type { RemoteEntry } from "../../shared/types";

export type FileIconKind =
  | "archive"
  | "audio"
  | "binary"
  | "code"
  | "file"
  | "image"
  | "text"
  | "video";

const iconNames: Record<FileIconKind, IconName> = {
  archive: "file-archive",
  audio: "file-audio",
  binary: "file-binary",
  code: "file-code",
  file: "file",
  image: "file-image",
  text: "file-text",
  video: "file-video",
};

export function remoteEntryIconName(entry: RemoteEntry): IconName {
  if (entry.kind === "directory") {
    return "folder";
  }

  if (entry.kind === "symlink") {
    return "external-link";
  }

  return iconNames[fileIconKind(entry.name)];
}

export function fileIconKind(name: string): FileIconKind {
  const extension = fileExtension(name);

  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  if (archiveExtensions.has(extension)) return "archive";
  if (codeExtensions.has(extension)) return "code";
  if (textExtensions.has(extension)) return "text";
  if (binaryExtensions.has(extension)) return "binary";
  return "file";
}

function fileExtension(name: string) {
  const cleanName = name.trim().toLowerCase();
  const compoundMatch = /\.(tar\.gz|tar\.bz2|tar\.xz|d\.ts)$/.exec(cleanName);

  if (compoundMatch) {
    return compoundMatch[1];
  }

  const dotIndex = cleanName.lastIndexOf(".");
  return dotIndex >= 0 ? cleanName.slice(dotIndex + 1) : "";
}

const imageExtensions = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const videoExtensions = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"]);
const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"]);
const archiveExtensions = new Set(["7z", "bz2", "gz", "jar", "rar", "tar", "tar.bz2", "tar.gz", "tar.xz", "tgz", "war", "xz", "zip"]);
const codeExtensions = new Set([
  "bat",
  "c",
  "cmd",
  "cpp",
  "cs",
  "css",
  "d.ts",
  "go",
  "h",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "ts",
  "tsx",
  "vue",
]);
const textExtensions = new Set(["conf", "csv", "env", "ini", "json", "log", "md", "properties", "text", "toml", "txt", "xml", "yaml", "yml"]);
const binaryExtensions = new Set(["bin", "dll", "dmg", "exe", "msi", "o", "obj", "so"]);
