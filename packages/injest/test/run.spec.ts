import assert from "node:assert/strict";
import { relative } from "node:path";
import { test } from "node:test";

import { reportOutput, summarize, toProjectRelative, type TestResult } from "../src/host/run.js";
import { captureStdout } from "./helpers/capture.js";

test("toProjectRelative: undefined passes through", () => {
  assert.equal(toProjectRelative(undefined), undefined);
});

test("toProjectRelative: makes an absolute path project-relative", () => {
  const abs = process.cwd() + "/tests/foo.test.ts";
  assert.equal(toProjectRelative(abs), relative(process.cwd(), abs));
});

const results: TestResult[] = [
  { index: 0, name: "a", durationMs: 1, status: "passed" },
  { index: 1, name: "b", durationMs: 1, status: "failed" },
  { index: 2, name: "c", durationMs: 1, status: "timeout" },
  { index: 3, name: "d", durationMs: 1, status: "crashed" },
  { index: 4, name: "e", durationMs: 1, status: "incomplete" },
  { index: 5, name: "f", durationMs: 1, status: "skipped" },
];

test("summarize: failed bucket includes timeout, crashed and incomplete", async () => {
  let counts!: { passed: number; failed: number };
  await captureStdout(() => {
    counts = summarize(results, "pretty");
  });
  assert.deepEqual(counts, { passed: 1, failed: 4 });
});

test("summarize: json reporter emits an end record", async () => {
  const out = await captureStdout(() => summarize(results, "json"));
  const record = JSON.parse(out.trim());
  assert.deepEqual(record, {
    type: "end",
    passed: 1,
    failed: 4,
    skipped: 1,
    total: 6,
  });
});

test("reportOutput: json reporter emits an output record", async () => {
  const out = await captureStdout(() =>
    reportOutput({ level: "info", text: "hello", name: "a", file: "f.ts", line: 3 }, "json"),
  );
  assert.deepEqual(JSON.parse(out.trim()), {
    type: "output",
    level: "info",
    text: "hello",
    name: "a",
    file: "f.ts",
    line: 3,
  });
});

test("reportOutput: pretty reporter indents each line under the test", async () => {
  const out = await captureStdout(() =>
    reportOutput({ level: "info", text: "one\ntwo\n" }, "pretty"),
  );
  assert.equal(out, "    │ one\n    │ two\n");
});
