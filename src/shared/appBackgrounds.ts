import type { AppBackgroundPresetId, AppBackgroundSettings } from "./types";

export interface AppBackgroundPreset {
  description: string;
  id: Exclude<AppBackgroundPresetId, "custom">;
  image: string;
  label: string;
}

export type AppBackgroundCssVariables = Record<`--${string}`, string>;

export const defaultAppBackground: AppBackgroundSettings = {
  enabled: false,
  preset: "aurora",
  customImage: null,
  opacity: 30,
  blur: 0,
};

export const appBackgroundPresets: AppBackgroundPreset[] = [
  {
    id: "aurora",
    label: "极光",
    description: "冷色流光",
    image: "url('/backgrounds/aurora.svg')",
  },
  {
    id: "horizon",
    label: "远山",
    description: "柔和山影",
    image: "url('/backgrounds/horizon.svg')",
  },
  {
    id: "topography",
    label: "等高线",
    description: "低对比纹理",
    image: "url('/backgrounds/topography.svg')",
  },
];

export function resolveAppBackgroundImage(background: AppBackgroundSettings): string {
  if (!background.enabled) {
    return "none";
  }

  if (background.preset === "custom") {
    return background.customImage ? `url("${background.customImage}")` : "none";
  }

  return appBackgroundPresets.find((preset) => preset.id === background.preset)?.image ?? "none";
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));
const percent = (value: number) => `${Math.round(value)}%`;

function resolveWallpaperMetrics(background: AppBackgroundSettings) {
  const strength = clampPercent(background.opacity) / 100;
  const reveal = Math.sqrt(strength);
  const surfaceOpacity = 100 * (1 - strength);

  return {
    controlOpacity: surfaceOpacity,
    headerOpacity: surfaceOpacity,
    imageOpacity: strength,
    overlayOpacity: 100 - reveal * 8,
    pageOpacity: 100 * Math.pow(1 - strength, 5),
    panelOpacity: surfaceOpacity,
    strength,
  };
}

/**
 * Produces stable wallpaper surface metrics from one user-facing strength.
 * Enabling the background only changes the resolved image; the same opacity
 * curve remains active for bodies, headers and controls in both states. Blur
 * is independent and maps directly to the user-facing 0–24 px value.
 */
export function resolveAppBackgroundCssVariables(
  background: AppBackgroundSettings,
): AppBackgroundCssVariables {
  const metrics = resolveWallpaperMetrics(background);

  return {
    "--app-background-image": resolveAppBackgroundImage(background),
    "--app-background-opacity": String(metrics.imageOpacity),
    "--app-background-blur": `${Math.min(24, Math.max(0, background.blur))}px`,
    "--wallpaper-veil-opacity": percent((1 - metrics.strength) * 30),
    "--wallpaper-page-opacity": percent(metrics.pageOpacity),
    "--wallpaper-panel-opacity": percent(metrics.panelOpacity),
    "--wallpaper-header-opacity": percent(metrics.headerOpacity),
    "--wallpaper-control-opacity": percent(metrics.controlOpacity),
    "--wallpaper-overlay-opacity": percent(metrics.overlayOpacity),
  };
}

export function resolveAppBackgroundTerminalColor(
  background: AppBackgroundSettings,
  terminalBackground: string,
): string {
  if (background.opacity <= 0) {
    return terminalBackground;
  }

  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(terminalBackground);
  if (!match) {
    return terminalBackground;
  }

  const alpha = resolveWallpaperMetrics(background).panelOpacity / 100;
  const [red, green, blue] = match.slice(1).map((channel) => Number.parseInt(channel, 16));
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}
