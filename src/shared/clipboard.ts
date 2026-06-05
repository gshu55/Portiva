import { clipboardReadText, clipboardWriteHtml, clipboardWriteText } from "./ipc/commands";

function isTauriRuntime() {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export async function readClipboardText() {
  try {
    return await clipboardReadText();
  } catch (error) {
    if (isTauriRuntime()) {
      throw error;
    }

    return navigator.clipboard.readText();
  }
}

export async function writeClipboardText(text: string) {
  try {
    await clipboardWriteText(text);
  } catch (error) {
    if (isTauriRuntime()) {
      throw error;
    }

    await navigator.clipboard.writeText(text);
  }
}

export async function writeClipboardHtml(html: string, text: string) {
  try {
    await clipboardWriteHtml(html, text);
  } catch (error) {
    if (isTauriRuntime()) {
      throw error;
    }

    if ("ClipboardItem" in window) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return;
    }

    await navigator.clipboard.writeText(text);
  }
}
