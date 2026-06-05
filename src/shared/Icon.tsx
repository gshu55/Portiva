import type { SVGProps } from "react";

export type IconName =
  | "ban"
  | "activity"
  | "chevron-left"
  | "chevron-right"
  | "check"
  | "columns-2"
  | "command"
  | "copy"
  | "download"
  | "edit"
  | "external-link"
  | "file"
  | "file-archive"
  | "file-audio"
  | "file-binary"
  | "file-code"
  | "file-image"
  | "file-text"
  | "file-video"
  | "folder"
  | "folder-open"
  | "folder-plus"
  | "hard-drive"
  | "home"
  | "keyboard"
  | "maximize"
  | "minus"
  | "minimize"
  | "monitor"
  | "moon"
  | "network"
  | "palette"
  | "pause"
  | "play"
  | "plug"
  | "plus"
  | "refresh-ccw"
  | "restore"
  | "rotate-ccw"
  | "save"
  | "settings"
  | "server"
  | "shield"
  | "sun"
  | "terminal"
  | "trash"
  | "upload"
  | "x";

const iconPaths: Record<IconName, string[]> = {
  activity: ["M22 12h-4l-3 8L9 4l-3 8H2"],
  ban: ["M4.93 4.93 19.07 19.07", "M20 12a8 8 0 0 1-12.58 6.56A8 8 0 0 1 18.56 7.42 8 8 0 0 1 20 12Z"],
  "chevron-left": ["m15 18-6-6 6-6"],
  "chevron-right": ["m9 18 6-6-6-6"],
  check: ["M20 6 9 17l-5-5"],
  "columns-2": ["M4 4h16v16H4z", "M12 4v16"],
  command: [
    "M18 8a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V5a3 3 0 1 0-3 3h12",
  ],
  copy: ["M8 8h10v10H8z", "M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  download: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
  edit: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  "external-link": ["M15 3h6v6", "M10 14 21 3", "M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"],
  file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6"],
  "file-archive": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M10 11h4", "M10 14h4", "M10 17h4"],
  "file-audio": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M9 17V11l5-1v6", "M9 17a1.5 1.5 0 1 1-1.5-1.5A1.5 1.5 0 0 1 9 17Z", "M14 16a1.5 1.5 0 1 1-1.5-1.5A1.5 1.5 0 0 1 14 16Z"],
  "file-binary": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M8 12h2v6H8z", "M14 12h2v6h-2z"],
  "file-code": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "m10 13-2 2 2 2", "m14 13 2 2-2 2"],
  "file-image": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M8 17l2.5-3 2 2.5L14 15l2 2", "M9.5 11.5h.01"],
  "file-text": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M8 13h8", "M8 16h8", "M8 19h5"],
  "file-video": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M8 13h5v4H8z", "m13 14 3-2v6l-3-2"],
  folder: ["M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
  "folder-open": ["M6 14h13l-2 6H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3"],
  "folder-plus": ["M12 10v6", "M9 13h6", "M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
  "hard-drive": ["M22 12H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z", "M6 16h.01", "M10 16h.01"],
  home: ["M3 10.5 12 3l9 7.5", "M5 10v10h14V10", "M9 20v-6h6v6"],
  keyboard: ["M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z", "M6 9h.01", "M10 9h.01", "M14 9h.01", "M18 9h.01", "M8 13h8", "M18 13h.01", "M6 13h.01"],
  maximize: ["M5 5h14v14H5z"],
  minus: ["M5 12h14"],
  minimize: ["M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16h3a2 2 0 0 1 2 2v3", "M16 21v-3a2 2 0 0 1 2-2h3"],
  monitor: ["M3 4h18v12H3z", "M8 20h8", "M12 16v4"],
  moon: ["M21 12.8A8.5 8.5 0 1 1 11.2 3 6.5 6.5 0 0 0 21 12.8Z"],
  network: ["M12 3v6", "M6 15v6", "M18 15v6", "M12 9 6 15", "M12 9l6 6", "M4 21h4", "M10 3h4", "M16 21h4"],
  palette: ["M12 3a9 9 0 0 0 0 18h1.5a1.8 1.8 0 0 0 1.2-3.1 1.8 1.8 0 0 1 1.2-3.1H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z", "M7.5 10h.01", "M10 7h.01", "M14 7h.01", "M16.5 10h.01"],
  pause: ["M6 4h4v16H6z", "M14 4h4v16h-4z"],
  play: ["M5 3v18l15-9Z"],
  plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M6 8h12v4a6 6 0 0 1-12 0Z"],
  plus: ["M5 12h14", "M12 5v14"],
  "refresh-ccw": ["M3 2v6h6", "M21 12a9 9 0 0 0-15-6.7L3 8", "M21 22v-6h-6", "M3 12a9 9 0 0 0 15 6.7l3-2.7"],
  restore: ["M5 8h11v11H5z", "M8 8V5h11v11h-3"],
  "rotate-ccw": ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
  save: ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z", "M17 21v-8H7v8", "M7 3v5h8"],
  settings: ["M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 16 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.24.4.58.73 1 .94.32.17.69.24 1.05.2H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M7 7h.01", "M7 17h.01"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z", "M9 12l2 2 4-5"],
  sun: ["M12 4V2", "M12 22v-2", "M4.93 4.93 3.51 3.51", "M20.49 20.49l-1.42-1.42", "M2 12h2", "M22 12h-2", "M4.93 19.07l-1.42 1.42", "M20.49 3.51l-1.42 1.42", "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"],
  terminal: ["M4 17l6-5-6-5", "M12 19h8"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v5", "M14 11v5"],
  upload: ["M12 3v12", "m7 8 5-5 5 5", "M5 21h14"],
  x: ["M18 6 6 18", "M6 6l12 12"],
};

export function Icon({ name, className = "", ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      className={["icon", className].filter(Boolean).join(" ")}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      {...props}
    >
      {iconPaths[name].map((path) => (
        <path d={path} key={path} />
      ))}
    </svg>
  );
}
