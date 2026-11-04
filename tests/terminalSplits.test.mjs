import assert from "node:assert/strict";
import { test } from "node:test";
import { replaceTerminalInLayout } from "../src/shared/terminalSplits.ts";

const layout = {
  type: "split",
  orientation: "columns",
  ratio: 0.37,
  first: { type: "terminal", terminalId: "primary" },
  second: {
    type: "split",
    orientation: "rows",
    ratio: 0.62,
    first: { type: "terminal", terminalId: "second" },
    second: { type: "terminal", terminalId: "third" },
  },
};

test("restarting the primary terminal preserves the other split panes and ratios", () => {
  const replaced = replaceTerminalInLayout(layout, "primary", "x11-primary");
  assert.equal(replaced.first.terminalId, "x11-primary");
  assert.equal(replaced.ratio, 0.37);
  assert.equal(replaced.second, layout.second);
  assert.equal(layout.first.terminalId, "primary");
});

test("restarting a nested terminal updates only its leaf", () => {
  const replaced = replaceTerminalInLayout(layout, "third", "x11-third");
  assert.equal(replaced.second.second.terminalId, "x11-third");
  assert.equal(replaced.second.ratio, 0.62);
  assert.equal(replaced.first, layout.first);
  assert.equal(replaced.second.first, layout.second.first);
});

test("a terminal no longer present leaves the layout intact", () => {
  assert.equal(replaceTerminalInLayout(layout, "closed", "new"), layout);
});
