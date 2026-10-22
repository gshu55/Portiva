import type { Terminal } from "@xterm/xterm";

interface CursorPosition {
  x: number;
  y: number;
}

interface Composition {
  start: number;
  sent: boolean;
}

// Compatibility bridge for the pinned xterm 6.0.0 implementation. Remove when
// upstream #6250 / #6089 are fixed: its shared pending-send flag lets an old
// composition callback send again after a newer composition has started.
interface CompositionHelper {
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _compositionPosition: { start: number; end: number };
  _compositionView: HTMLDivElement;
  _renderService: { dimensions: { css: { cell: { width: number; height: number } } } };
  compositionstart(): void;
  keydown(event: KeyboardEvent): boolean;
  _finalizeComposition(waitForPropagation: boolean): void;
  _handleAnyTextareaChanges(): void;
  updateCompositionElements(dontRecurse?: boolean): void;
}

interface ImeCore {
  _compositionHelper: CompositionHelper;
  _syncTextArea(): void;
  coreService: { isCursorHidden: boolean };
}

export function installTerminalIme(terminal: Terminal): () => void {
  const textarea = terminal.textarea;
  const core = (terminal as unknown as { _core: ImeCore })._core;
  const helper = core._compositionHelper;
  if (!textarea || !helper) {
    return () => undefined;
  }

  const originals = {
    start: helper.compositionstart,
    keydown: helper.keydown,
    finalize: helper._finalizeComposition,
    changes: helper._handleAnyTextareaChanges,
    position: helper.updateCompositionElements,
    sync: core._syncTextArea,
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let composition: Composition | null = null;
  let generation = 0;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let stableCursor: CursorPosition | null = null;
  let composingCursor: CursorPosition | null = null;

  const defer = (callback: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, 0);
    timers.add(timer);
    return timer;
  };

  const readCursor = (): CursorPosition | null => {
    const buffer = terminal.buffer.active;
    const y = buffer.baseY + buffer.cursorY - buffer.viewportY;
    return y >= 0 && y < terminal.rows
      ? { x: Math.min(buffer.cursorX, terminal.cols - 1), y }
      : null;
  };

  const position = (cursor: CursorPosition, composing: boolean) => {
    const { width, height } = helper._renderService.dimensions.css.cell;
    if (width <= 0 || height <= 0) return;
    const x = Math.min(cursor.x, terminal.cols - 1);
    const y = Math.min(cursor.y, terminal.rows - 1);
    const left = `${x * width}px`;
    const top = `${y * height}px`;
    let inputWidth = width;
    if (composing) {
      const view = helper._compositionView;
      Object.assign(view.style, {
        left, top,
        height: `${height}px`,
        lineHeight: `${height}px`,
        fontFamily: terminal.options.fontFamily,
        fontSize: `${terminal.options.fontSize}px`,
        maxWidth: `${(terminal.cols - x) * width}px`,
        overflow: "hidden",
      });
      inputWidth = view.getBoundingClientRect().width;
    }
    Object.assign(textarea.style, {
      left, top,
      width: `${Math.max(inputWidth, 1)}px`,
      height: `${Math.max(height, 1)}px`,
      lineHeight: `${height}px`,
    });
  };

  const sync = () => {
    const cursor = helper._isComposing ? composingCursor : stableCursor;
    if (cursor) position(cursor, helper._isComposing);
  };

  const finish = (pending: Composition) => {
    if (pending.sent || disposed) return;
    pending.sent = true;
    // Read the live value before the next key edits it. The old end offset is
    // updated by a timer and can still belong to the previous composition.
    const input = textarea.value.slice(pending.start + helper._dataAlreadySent.length);
    if (composition === pending) helper._isSendingComposition = false;
    if (input) terminal.input(input, true);
  };

  helper.compositionstart = () => {
    // Flush before the browser replaces the composing range for the next word.
    if (composition) finish(composition);
    generation += 1;
    originals.start.call(helper);
    composition = { start: helper._compositionPosition.start, sent: false };
    composingCursor = stableCursor ?? readCursor();
    sync();
  };
  helper._finalizeComposition = (waitForPropagation) => {
    helper._compositionView.classList.remove("active");
    helper._isComposing = false;
    const pending = composition;
    if (!pending || pending.sent) return;
    if (waitForPropagation) {
      helper._isSendingComposition = true;
      // Each callback owns its composition; a newer one cannot reactivate it.
      defer(() => finish(pending));
    } else {
      finish(pending);
    }
  };
  helper.keydown = (event) => event.isComposing ? false : originals.keydown.call(helper, event);
  helper._handleAnyTextareaChanges = () => {
    if (changeTimer !== null) return;
    const oldValue = textarea.value;
    const revision = generation;
    changeTimer = defer(() => {
      changeTimer = null;
      // A keyCode=229 probe queued before compositionstart must not emit the
      // text that compositionend is already responsible for sending.
      if (revision !== generation || helper._isComposing) return;
      const newValue = textarea.value;
      const diff = newValue.replace(oldValue, "");
      helper._dataAlreadySent = diff;
      if (newValue.length > oldValue.length) terminal.input(diff, true);
      else if (newValue.length < oldValue.length) terminal.input("\x7f", true);
      else if (newValue !== oldValue) terminal.input(newValue, true);
    });
  };
  helper.updateCompositionElements = () => {
    if (helper._isComposing) sync();
  };
  // xterm also moves the hidden textarea on intermediate cursor movements.
  // Use completed parser frames, and hold that anchor while the IME is open.
  core._syncTextArea = sync;
  const updateCursor = () => {
    const cursor = readCursor();
    if (cursor && !(core.coreService.isCursorHidden && cursor.x === 0 && cursor.y === 0 && stableCursor)) {
      stableCursor = cursor;
    }
    sync();
  };
  const flushOnBlur = () => {
    if (composition && !helper._isComposing) finish(composition);
  };
  textarea.addEventListener("blur", flushOnBlur, true);
  textarea.addEventListener("focus", sync);
  const subscriptions = [
    terminal.onWriteParsed(updateCursor),
    terminal.onRender(sync),
  ];
  updateCursor();

  return () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
    textarea.removeEventListener("blur", flushOnBlur, true);
    textarea.removeEventListener("focus", sync);
    helper.compositionstart = originals.start;
    helper.keydown = originals.keydown;
    helper._finalizeComposition = originals.finalize;
    helper._handleAnyTextareaChanges = originals.changes;
    helper.updateCompositionElements = originals.position;
    core._syncTextArea = originals.sync;
  };
}
