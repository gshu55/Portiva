import type { AppSettings, TerminalColorPalette, TerminalColorPresetId } from "./types";

export interface TerminalThemePreset {
  colors: TerminalColorPalette;
  description: string;
  id: Exclude<TerminalColorPresetId, "custom">;
  label: string;
}

export const terminalColorPresets: Record<Exclude<TerminalColorPresetId, "custom">, TerminalThemePreset> = {
  dark: {
    id: "dark",
    label: "深色",
    description: "One Dark 常用 ANSI 配色",
    colors: {
      background: "#282C34",
      foreground: "#ABB2BF",
      cursor: "#528BFF",
      selectionBackground: "#3E4451",
      black: "#5C6370",
      red: "#E06C75",
      green: "#98C379",
      yellow: "#E5C07B",
      blue: "#61AFEF",
      magenta: "#C678DD",
      cyan: "#56B6C2",
      white: "#ABB2BF",
      brightBlack: "#4B5263",
      brightRed: "#BE5046",
      brightGreen: "#98C379",
      brightYellow: "#D19A66",
      brightBlue: "#61AFEF",
      brightMagenta: "#C678DD",
      brightCyan: "#56B6C2",
      brightWhite: "#FFFFFF",
    },
  },
  light: {
    id: "light",
    label: "浅色",
    description: "匹配当前浅色主题",
    colors: {
      background: "#F7FAFB",
      foreground: "#26333A",
      cursor: "#147D70",
      selectionBackground: "#D7EEE9",
      black: "#142027",
      red: "#B14B28",
      green: "#4F7D22",
      yellow: "#8A6500",
      blue: "#286FA8",
      magenta: "#8A4FA8",
      cyan: "#147D70",
      white: "#DDE5E8",
      brightBlack: "#66747C",
      brightRed: "#C45D38",
      brightGreen: "#669528",
      brightYellow: "#A77900",
      brightBlue: "#347FBD",
      brightMagenta: "#9B60B8",
      brightCyan: "#1D9485",
      brightWhite: "#FFFFFF",
    },
  },
};

export const defaultTerminalColors = terminalColorPresets.dark.colors;

export const terminalColorKeys = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type TerminalColorKey = (typeof terminalColorKeys)[number];

export function resolveTerminalPalette(theme: AppSettings["theme"]): TerminalColorPalette {
  if (theme.terminalColorPreset === "dark" || theme.terminalColorPreset === "light") {
    return terminalColorPresets[theme.terminalColorPreset].colors;
  }

  return {
    ...defaultTerminalColors,
    ...theme.terminalColors,
  };
}
