import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compile = (url) => ts.transpileModule(readFileSync(url, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true,
  },
}).outputText;
// Exercise the installed xterm implementation, including its original keydown,
// compositionupdate and compositionend methods, rather than a parallel model.
const helperCode = compile(new URL("../node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts", import.meta.url));
const fixCode = compile(new URL("../src/features/terminal/terminalIme.ts", import.meta.url));

function setup(patched = true) {
  let nextTimer = 0;
  const timers = new Map();
  const context = vm.createContext({
    exports: {},
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    require: (name) => name.endsWith("EscapeSequences")
      ? { C0: { DEL: "\x7f" } }
      : { IRenderService() {}, IBufferService() {}, ICoreService() {}, IOptionsService() {} },
  });
  vm.runInContext(helperCode, context);
  const { CompositionHelper } = context.exports;
  context.exports = {};
  vm.runInContext(fixCode, context);
  const sent = [];
  const textarea = Object.assign(new EventTarget(), { value: "", style: {} });
  const view = {
    style: {}, textContent: "",
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ width: 32, height: 18 }),
  };
  const buffer = { cursorX: 19, cursorY: 11, baseY: 0, viewportY: 0 };
  const options = { fontFamily: "monospace", fontSize: 13 };
  const input = (data) => { if (data) sent.push(data); };
  const helper = new CompositionHelper(
    textarea, view,
    { cols: 100, buffer: { isCursorInViewport: true, x: 19, y: 11 } },
    { rawOptions: options },
    { triggerDataEvent: input },
    { dimensions: { css: { cell: { width: 8, height: 18 } } } },
  );
  const listeners = new Map();
  const subscribe = (name) => (callback) => {
    const callbacks = listeners.get(name) ?? new Set();
    callbacks.add(callback);
    listeners.set(name, callbacks);
    return { dispose: () => callbacks.delete(callback) };
  };
  const terminal = {
    textarea, cols: 100, rows: 30, options, input,
    buffer: { active: buffer },
    _core: { _compositionHelper: helper, _syncTextArea() {}, coreService: { isCursorHidden: false } },
    onWriteParsed: subscribe("parsed"), onRender: subscribe("render"),
  };
  const dispose = patched ? context.exports.installTerminalIme(terminal) : () => {};
  const emit = (name) => listeners.get(name)?.forEach((callback) => callback());
  const step = () => {
    const entry = timers.entries().next().value;
    if (entry) { timers.delete(entry[0]); entry[1](); }
  };
  const flush = () => {
    let attempts = 0;
    while (timers.size && attempts++ < 100) step();
    assert.equal(timers.size, 0, "timers must settle");
  };
  const compose = (text) => {
    helper.compositionstart();
    helper.compositionupdate({ data: text });
    textarea.value += text;
    helper.compositionend();
  };
  const space = () => {
    if (helper.keydown({ keyCode: 32, isComposing: false })) input(" ");
    textarea.value += " ";
  };
  return { helper, terminal, textarea, view, buffer, sent, compose, space, step, flush, emit, dispose };
}

test("fixture reproduces incorrect input in the unpatched xterm 6.0.0", () => {
  const t = setup(false);
  t.compose("你"); t.space(); t.compose("好"); t.space(); t.flush();
  assert.notEqual(t.sent.join(""), "你 好 ");
});

for (const interveningTimers of [0, 1]) {
  test(`a next key before composition callbacks never duplicates Chinese (${interveningTimers} timer)`, () => {
    const t = setup();
    t.compose("你");
    for (let i = 0; i < interveningTimers; i++) t.step();
    t.space(); t.compose("好"); t.space(); t.flush();
    assert.deepEqual(t.sent, ["你", " ", "好", " "]);
  });
}

test("back-to-back compositions and intentional repeated words are retained", () => {
  const t = setup();
  t.compose("你好"); t.compose("你好"); t.compose("世界"); t.flush();
  assert.deepEqual(t.sent, ["你好", "你好", "世界"]);
});

test("keyCode 229 probes cannot replay text belonging to a later composition", () => {
  const t = setup();
  t.helper.keydown({ keyCode: 229 });
  t.compose("你"); t.compose("好"); t.flush();
  assert.deepEqual(t.sent, ["你", "好"]);
});

test("IME punctuation without compositionstart is still sent once", () => {
  const t = setup();
  t.helper.keydown({ keyCode: 229 });
  t.textarea.value += "。";
  t.helper.compositionend(); t.flush();
  assert.deepEqual(t.sent, ["。"]);
});

test("cancelled composition sends nothing and does not poison the next word", () => {
  const t = setup();
  t.helper.compositionstart();
  t.helper.compositionupdate({ data: "nihao" });
  t.textarea.value = "";
  t.helper.compositionend(); t.flush();
  assert.deepEqual(t.sent, []);
  t.compose("你好"); t.flush();
  assert.deepEqual(t.sent, ["你好"]);
});

test("isComposing Enter and Escape stay with the IME even without keyCode 229", () => {
  const t = setup();
  t.helper.compositionstart();
  t.textarea.value = "你";
  assert.equal(t.helper.keydown({ keyCode: 13, isComposing: true }), false);
  assert.equal(t.helper.keydown({ keyCode: 27, isComposing: true }), false);
  assert.deepEqual(t.sent, []);
  t.helper.compositionend(); t.flush();
  assert.deepEqual(t.sent, ["你"]);
});

test("a pending commit is flushed before xterm clears its textarea on blur", () => {
  const t = setup();
  t.compose("你好");
  t.textarea.dispatchEvent(new Event("blur"));
  t.textarea.value = "";
  t.flush();
  assert.deepEqual(t.sent, ["你好"]);
});

test("preedit and candidate anchor remain fixed during terminal redraws", () => {
  const t = setup();
  t.helper.compositionstart(); t.helper.compositionupdate({ data: "nihao" });
  assert.equal(t.textarea.style.left, "152px");
  assert.equal(t.textarea.style.top, "198px");
  t.buffer.cursorX = 0; t.buffer.cursorY = 0;
  t.terminal._core._syncTextArea(); t.emit("parsed");
  t.helper.updateCompositionElements(); t.emit("render");
  assert.equal(t.textarea.style.left, "152px");
  assert.equal(t.textarea.style.top, "198px");
  assert.equal(t.view.style.left, "152px");
});

test("a hidden cursor parked at home keeps the last usable IME anchor", () => {
  const t = setup();
  t.terminal._core.coreService.isCursorHidden = true;
  t.buffer.cursorX = 0; t.buffer.cursorY = 0; t.emit("parsed");
  assert.equal(t.textarea.style.top, "198px");
  t.terminal._core.coreService.isCursorHidden = false; t.emit("parsed");
  assert.equal(t.textarea.style.top, "0px");
  assert.equal(t.textarea.style.left, "0px");
});

test("anchor uses viewport coordinates and clamps to resized terminal bounds", () => {
  const t = setup();
  t.buffer.baseY = 100; t.buffer.viewportY = 105; t.emit("parsed");
  assert.equal(t.textarea.style.top, "108px");
  t.helper.compositionstart();
  t.terminal.cols = 10; t.terminal.rows = 5; t.emit("render");
  assert.equal(t.textarea.style.left, "72px");
  assert.equal(t.textarea.style.top, "72px");
});

test("disposal cancels pending sends and restores xterm methods and subscriptions", () => {
  const t = setup();
  t.compose("你好"); t.dispose(); t.flush();
  assert.deepEqual(t.sent, []);
  t.buffer.cursorX = 0; t.buffer.cursorY = 0; t.emit("parsed");
  assert.equal(t.textarea.style.left, "152px");
});
