import assert from "node:assert/strict";
import { test } from "node:test";

import { NdjsonParser, fileId, parseFileId, parseStackFrames, stableId } from "../src/parse.js";

test("NdjsonParser: emits one object per complete line", () => {
  const parser = new NdjsonParser();
  assert.deepEqual(parser.push('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});

test("NdjsonParser: holds a partial line until its newline arrives", () => {
  const parser = new NdjsonParser();
  assert.deepEqual(parser.push('{"type":"te'), []);
  assert.deepEqual(parser.push('st","status":"passed"}\n'), [{ type: "test", status: "passed" }]);
});

test("NdjsonParser: skips blank and non-JSON lines, keeps valid ones", () => {
  const parser = new NdjsonParser();
  assert.deepEqual(parser.push('\n  \nnot json\n{"ok":true}\n'), [{ ok: true }]);
});

test("NdjsonParser: flush parses a trailing line with no newline", () => {
  const parser = new NdjsonParser();
  assert.deepEqual(parser.push('{"end":1}'), []);
  assert.deepEqual(parser.flush(), [{ end: 1 }]);
});

test("NdjsonParser: flush is empty when nothing is buffered", () => {
  const parser = new NdjsonParser();
  parser.push('{"a":1}\n');
  assert.deepEqual(parser.flush(), []);
});

test("parseFileId inverts fileId", () => {
  assert.deepEqual(parseFileId(fileId(2, "tests/a.test.ts")), {
    folderIndex: 2,
    rel: "tests/a.test.ts",
  });
});

test("parseFileId splits only on the first colon", () => {
  assert.deepEqual(parseFileId("0:dir/a:b.test.ts"), { folderIndex: 0, rel: "dir/a:b.test.ts" });
  assert.match(stableId(1, "x.test.ts", "suite › t"), /^1:x\.test\.ts::suite › t$/);
});

const exists = (): boolean => true;
const missing = (): boolean => false;

test("parseStackFrames: parses label, resolved path, line and column", () => {
  const [frame] = parseStackFrames("    at myTest (tests/a.test.ts:10:5)", "/proj", exists);
  assert.deepEqual(frame, { label: "myTest", file: "/proj/tests/a.test.ts", line: 10, column: 5 });
});

test("parseStackFrames: defaults the column to 1 when omitted", () => {
  const [frame] = parseStackFrames("at fn (/abs/a.test.ts:7)", "/proj", exists);
  assert.equal(frame.file, "/abs/a.test.ts");
  assert.equal(frame.column, 1);
});

test("parseStackFrames: drops runner-internal frames", () => {
  const stack = [
    "at boom (tests/a.test.ts:3:1)",
    "at run (src/agent/runtime.ts:1:1)",
    "at assert (src/agent/expect.ts:9:2)",
    "at entry (.injest-123/entry.ts:1:1)",
  ].join("\n");
  const frames = parseStackFrames(stack, "/proj", exists);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].label, "boom");
});

test("parseStackFrames: drops native and unparseable frames", () => {
  const stack = ["at native", "at fn (no-location-here)", "garbage line"].join("\n");
  assert.deepEqual(parseStackFrames(stack, "/proj", exists), []);
});

test("parseStackFrames: drops frames whose file is not on disk", () => {
  assert.deepEqual(parseStackFrames("at fn (tests/a.test.ts:1:1)", "/proj", missing), []);
});
