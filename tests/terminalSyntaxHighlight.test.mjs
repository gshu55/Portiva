import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const sourceUrl = new URL("../src/features/terminal/terminalSyntaxHighlight.ts", import.meta.url).href;

function highlight(text, language) {
  // Isolate the parser: a regression must fail within a bounded heap/time budget.
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--max-old-space-size=64",
    "--input-type=module",
    "-e",
    `import { terminalSyntaxSpans } from ${JSON.stringify(sourceUrl)};
console.log(JSON.stringify(terminalSyntaxSpans(${JSON.stringify(text)}, ${JSON.stringify(language)})));`,
  ], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const [language, line] of [["yaml", "name: portiva"], ["toml", "name = portiva"]]) {
  test(`${language} key produces one match and terminates`, () => {
    assert.deepEqual(highlight(line, language), [{ start: 0, end: 4, tone: "property" }]);
  });
}

test("global rules still highlight every number and keyword", () => {
  const spans = highlight("values: [1, 2, true, false]", "yaml");
  assert.equal(spans.filter((span) => span.tone === "property").length, 1);
  assert.equal(spans.filter((span) => span.tone === "number").length, 2);
  assert.equal(spans.filter((span) => span.tone === "keyword").length, 2);
});

test("configuration comments and strings keep their existing highlighting", () => {
  const line = 'name = "portiva" # 123';
  assert.deepEqual(highlight(line, "toml"), [
    { start: 7, end: 16, tone: "string" },
    { start: 17, end: line.length, tone: "comment" },
    { start: 0, end: 4, tone: "property" },
  ]);
  assert.deepEqual(highlight("plain text", "yaml"), []);
});
