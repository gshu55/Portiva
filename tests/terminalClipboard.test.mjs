import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureTerminalCopy,
  isTerminalCopyShortcut,
  writeTerminalCopy,
} from "../src/features/terminal/terminalClipboard.ts";

function terminal(selection = "Claude 回答内容") {
  return {
    getSelection: () => selection,
    buffer: { active: {
      length: 2,
      getLine: (row) => ({ translateToString: () => ["当前 TUI 画面", "第二行"][row] }),
    } },
  };
}

test("a right-click snapshot survives selection being cleared before menu activation", async () => {
  const instance = terminal();
  const payload = captureTerminalCopy(instance, null);
  instance.getSelection = () => "";
  const copied = [];
  await writeTerminalCopy(payload, { writeText: async (text) => copied.push(text) });
  assert.deepEqual(copied, ["Claude 回答内容"]);
});

test("smart copy distinguishes a selection from an empty selection without copying the whole buffer", () => {
  assert.equal(captureTerminalCopy(terminal(""), null), null);
  assert.deepEqual(captureTerminalCopy(terminal(""), null, { includeBuffer: true }), {
    text: "当前 TUI 画面\n第二行",
  });
  assert.equal(captureTerminalCopy(null, null, { includeBuffer: true }), null);
});

test("rich text is serialized while the original selection is still available", async () => {
  const options = [];
  const payload = captureTerminalCopy(terminal(), {
    serializeAsHTML: (value) => { options.push(value); return "<pre>Claude 回答内容</pre>"; },
  }, { richText: true });
  const writes = [];
  await writeTerminalCopy(payload, {
    writeText: async () => assert.fail("successful HTML writes already include plain text"),
    writeHtml: async (...args) => writes.push(args),
  });
  assert.deepEqual(options, [{ includeGlobalBackground: true, onlySelection: true }]);
  assert.deepEqual(writes, [["<pre>Claude 回答内容</pre>", "Claude 回答内容"]]);
});

test("failed HTML clipboard writes fall back to plain text", async (t) => {
  t.mock.method(console, "warn", () => {});
  const writes = [];
  await writeTerminalCopy({ text: "回答", html: "<pre>回答</pre>" }, {
    writeHtml: async () => { throw new Error("unsupported HTML clipboard format"); },
    writeText: async (text) => writes.push(text),
  });
  assert.deepEqual(writes, ["回答"]);
});

test("failed native clipboard writes remain visible to the caller", async () => {
  await assert.rejects(writeTerminalCopy({ text: "回答" }, {
    writeText: async () => { throw new Error("clipboard locked"); },
  }), /clipboard locked/);
});

const key = (overrides = {}) => ({
  type: "keydown", key: "c", keyCode: 67,
  ctrlKey: true, shiftKey: false, metaKey: false, altKey: false,
  isComposing: false, ...overrides,
});

test("Ctrl+C copies a selection and still interrupts the TUI when nothing is selected", () => {
  assert.equal(isTerminalCopyShortcut(key(), true), true);
  assert.equal(isTerminalCopyShortcut(key(), false), false);
});

test("Ctrl+Shift+C and Cmd+C are handled without requiring a browser copy event", () => {
  assert.equal(isTerminalCopyShortcut(key({ shiftKey: true }), true), true);
  assert.equal(isTerminalCopyShortcut(key({ shiftKey: true }), false), true);
  assert.equal(isTerminalCopyShortcut(key({ ctrlKey: false, metaKey: true }), true), true);
});

test("copy shortcuts do not consume composition, keyup or unrelated keys", () => {
  for (const overrides of [
    { isComposing: true }, { keyCode: 229 }, { type: "keyup" },
    { altKey: true }, { key: "v" }, { ctrlKey: false },
  ]) {
    assert.equal(isTerminalCopyShortcut(key(overrides), true), false);
  }
});
