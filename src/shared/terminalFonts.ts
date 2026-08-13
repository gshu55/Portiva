export const bundledTerminalFontFamily = "Portiva JetBrains Mono";
export const defaultTerminalFontSize = 13;
export const applicationFontReferenceSizes = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 22] as const;

export interface TerminalFontPreset {
  family: string;
  label: string;
}

export const systemTerminalFontPresets: TerminalFontPreset[] = [
  { family: "Cascadia Mono", label: "Cascadia Mono" },
  { family: "Cascadia Code", label: "Cascadia Code" },
  { family: "Consolas", label: "Consolas" },
  { family: "SFMono-Regular", label: "SF Mono" },
  { family: "Menlo", label: "Menlo" },
  { family: "Monaco", label: "Monaco" },
  { family: "Fira Code", label: "Fira Code" },
  { family: "Iosevka", label: "Iosevka" },
  { family: "Source Code Pro", label: "Source Code Pro" },
  { family: "IBM Plex Mono", label: "IBM Plex Mono" },
  { family: "Roboto Mono", label: "Roboto Mono" },
  { family: "Hack", label: "Hack" },
  { family: "DejaVu Sans Mono", label: "DejaVu Sans Mono" },
  { family: "Liberation Mono", label: "Liberation Mono" },
  { family: "Ubuntu Mono", label: "Ubuntu Mono" },
  { family: "Noto Sans Mono", label: "Noto Sans Mono" },
];

const fontDetectionFamilies = ["monospace", "sans-serif", "serif"] as const;
const fontDetectionText = "mmmmmmmmmmWW@@##0011llii";
const systemFontAvailability = new Map<string, boolean>();

export function registerAvailableSystemTerminalFonts(fontFamilies: string[]) {
  fontFamilies.forEach((fontFamily) => systemFontAvailability.set(fontFamily, true));
}

function quoteFontFamily(fontFamily: string) {
  return `"${fontFamily.replace(/["\\]/g, "\\$&")}"`;
}

export function isSystemTerminalFontAvailable(fontFamily: string) {
  const cached = systemFontAvailability.get(fontFamily);
  if (cached !== undefined) {
    return cached;
  }

  if (typeof document === "undefined") {
    return false;
  }

  const context = document.createElement("canvas").getContext("2d");
  if (!context) {
    return false;
  }

  const available = fontDetectionFamilies.some((baseFamily) => {
    context.font = `72px ${baseFamily}`;
    const baseWidth = context.measureText(fontDetectionText).width;
    context.font = `72px ${quoteFontFamily(fontFamily)}, ${baseFamily}`;
    const candidateWidth = context.measureText(fontDetectionText).width;
    return Math.abs(candidateWidth - baseWidth) > 0.01;
  });

  systemFontAvailability.set(fontFamily, available);
  return available;
}

export function resolveTerminalFontFamily(fontFamily: string) {
  const configuredFontFamily = fontFamily.trim();
  const bundledFont = quoteFontFamily(bundledTerminalFontFamily);

  if (!configuredFontFamily || configuredFontFamily === bundledTerminalFontFamily) {
    return bundledFont;
  }

  return isSystemTerminalFontAvailable(configuredFontFamily)
    ? `${quoteFontFamily(configuredFontFamily)}, ${bundledFont}`
    : bundledFont;
}

export function resolveTerminalFontSize(fontSize: number) {
  return Number.isFinite(fontSize) && fontSize >= 8 && fontSize <= 32
    ? fontSize
    : defaultTerminalFontSize;
}

export function resolveApplicationFontSize(referenceSize: number, fontSize: number) {
  const scale = resolveTerminalFontSize(fontSize) / defaultTerminalFontSize;
  return `${Math.round(referenceSize * scale * 100) / 100}px`;
}
