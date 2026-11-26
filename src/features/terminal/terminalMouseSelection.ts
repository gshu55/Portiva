import type { Terminal } from "@xterm/xterm";

/** Keep clicks in the CLI, but let xterm select its own buffer on a drag. */
export function bindTerminalMouseSelection(host: HTMLElement, terminal: Terminal, isSelectionCli: () => boolean) {
  let pending: AbortController | undefined;

  function cancelPress() {
    pending?.abort();
    pending = undefined;
  }

  function onMouseDown(event: MouseEvent) {
    if (
      !event.isTrusted || event.button !== 0 || event.buttons !== 1 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      !isSelectionCli() || terminal.modes.mouseTrackingMode === "none" ||
      !(event.target instanceof Element) || !event.target.closest(".xterm-screen")
    ) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    cancelPress();
    pending = new AbortController();
    const options = { capture: true, signal: pending.signal };

    // Replay the press at its original cell once we know whether it was a click
    // or a drag. xterm then handles mouse reporting, wide cells and wrapped rows.
    function startGesture(select: boolean) {
      cancelPress();
      const mac = navigator.platform.startsWith("Mac");
      terminal.element?.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: event.clientX,
        clientY: event.clientY,
        buttons: 1,
        detail: event.detail,
        altKey: select && mac,
        shiftKey: select && !mac,
      }));
    }

    window.addEventListener("mousemove", (move) => {
      if (!(move.buttons & 1)) {
        cancelPress();
      } else if (Math.max(Math.abs(move.clientX - event.clientX), Math.abs(move.clientY - event.clientY)) >= 3) {
        startGesture(true);
      }
    }, options);
    window.addEventListener("mouseup", (up) => {
      if (up.button === 0) {
        startGesture(false);
      }
    }, options);
    window.addEventListener("blur", cancelPress, { signal: pending.signal });
  }

  host.addEventListener("mousedown", onMouseDown, true);
  return () => {
    cancelPress();
    host.removeEventListener("mousedown", onMouseDown, true);
  };
}
