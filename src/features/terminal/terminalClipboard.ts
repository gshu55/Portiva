import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/xterm";

export interface TerminalCopyPayload {
  text: string;
  html?: string;
}

export function captureTerminalCopy(
  terminal: Terminal | null,
  serializer: Pick<SerializeAddon, "serializeAsHTML"> | null,
  options: { includeBuffer?: boolean; richText?: boolean } = {},
): TerminalCopyPayload | null {
  if (!terminal) return null;
  const selection = terminal.getSelection();
  let text = selection;
  if (!text && options.includeBuffer) {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    text = lines.join("\n");
  }
  if (!text) return null;

  // Snapshot both formats before a right click or a TUI redraw clears selection.
  const payload: TerminalCopyPayload = { text };
  if (options.richText && serializer) {
    try {
      payload.html = serializer.serializeAsHTML({
        includeGlobalBackground: true,
        onlySelection: Boolean(selection),
      }) || undefined;
    } catch (error) {
      console.warn("终端格式复制失败，将使用纯文本", error);
    }
  }
  return payload;
}

export async function writeTerminalCopy(
  payload: TerminalCopyPayload,
  clipboard: {
    writeText(text: string): Promise<void>;
    writeHtml(html: string, text: string): Promise<void>;
  },
) {
  if (payload.html) {
    try {
      await clipboard.writeHtml(payload.html, payload.text);
      return;
    } catch (error) {
      console.warn("终端格式复制失败，将使用纯文本", error);
    }
  }
  await clipboard.writeText(payload.text);
}

export function isTerminalCopyShortcut(event: KeyboardEvent, hasSelection: boolean) {
  if (event.type !== "keydown" || event.isComposing || event.keyCode === 229 || event.altKey) {
    return false;
  }
  if (event.key.toLowerCase() !== "c") return false;
  if (event.metaKey) return !event.ctrlKey && !event.shiftKey;
  // With no selection, Ctrl+C must still interrupt the foreground application.
  return event.ctrlKey && (event.shiftKey || hasSelection);
}
