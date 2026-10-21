import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  readTerminalPanelPreferences,
  writeTerminalPanelPreferences,
} from "../src/features/terminal/useTerminalPanelPreferences.ts";

const defaults = { command: false, sftp: true, status: false };
afterEach(() => { delete globalThis.window; });

test("panel choices survive a fresh read, including hidden SFTP", () => {
  const values = new Map();
  globalThis.window = { localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } };
  assert.deepEqual(readTerminalPanelPreferences(), defaults);
  for (const preferences of [
    { command: true, sftp: false, status: true },
    { command: false, sftp: true, status: false },
  ]) {
    writeTerminalPanelPreferences(preferences);
    assert.deepEqual(readTerminalPanelPreferences(), preferences);
  }
  assert.equal(values.size, 1);
});

test("missing or malformed preferences fall back safely", () => {
  for (const value of [null, "{", "null", "42", '"text"']) {
    globalThis.window = { localStorage: { getItem: () => value } };
    assert.deepEqual(readTerminalPanelPreferences(), defaults);
  }
});

test("valid fields are restored without accepting truthy non-booleans", () => {
  globalThis.window = { localStorage: {
    getItem: () => JSON.stringify({ command: "false", sftp: false, status: 1 }),
  } };
  assert.deepEqual(readTerminalPanelPreferences(), { ...defaults, sftp: false });
});

test("unavailable storage does not break panel controls", () => {
  globalThis.window = { get localStorage() { throw new Error("Storage unavailable"); } };
  assert.deepEqual(readTerminalPanelPreferences(), defaults);
  assert.doesNotThrow(() => writeTerminalPanelPreferences(defaults));
});
