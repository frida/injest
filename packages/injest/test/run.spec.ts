import assert from "node:assert/strict";
import { relative } from "node:path";
import { test } from "node:test";

import {
  reportOutput,
  reportResult,
  summarize,
  toProjectRelative,
  type TestResult,
} from "../src/host/run.js";
import { captureStdout } from "./helpers/capture.js";

const benchResult: TestResult = {
  index: 0,
  name: "list",
  durationMs: 3,
  status: "passed",
  kind: "bench",
  bench: {
    iterations: 3,
    tickUs: 1,
    wallUs: [1200, 900, 1000],
    userUs: [1100, 850, 950],
    counters: { tables: [1, 1, 1], calls: [82, 83, 82], scans: [0, 0, 0] },
  },
};

test("reportResult: pretty reporter summarizes a bench's samples and its non-zero counters", async () => {
  const out = await captureStdout(() => reportResult(benchResult, "pretty"));
  assert.equal(out, "  ✓ list (min 900µs, median 1.0ms, n=3) tables=1 calls=82..83\n");
});

test("reportResult: pretty reporter notes a bench new to, or drifted from, the baseline", async () => {
  const fresh = await captureStdout(() =>
    reportResult({ ...benchResult, baseline: { verdict: "new" } }, "pretty"),
  );
  assert.equal(fresh, "  ✓ list (min 900µs, median 1.0ms, n=3) tables=1 calls=82..83 [new]\n");
  const drifted = await captureStdout(() =>
    reportResult(
      { ...benchResult, baseline: { verdict: "drifted", detail: "tables 1 < 2" } },
      "pretty",
    ),
  );
  assert.equal(
    drifted,
    "  ✓ list (min 900µs, median 1.0ms, n=3) tables=1 calls=82..83 [baseline drift: tables 1 < 2]\n",
  );
});

test("reportResult: pretty reporter prints a single iteration as one time", async () => {
  const once: TestResult = {
    ...benchResult,
    bench: { iterations: 1, tickUs: 1, wallUs: [14100], counters: { tables: [2] } },
  };
  const out = await captureStdout(() => reportResult(once, "pretty"));
  assert.equal(out, "  ✓ list (14.1ms, once) tables=2\n");
});

test("reportResult: json reporter emits a bench record with its samples inline", async () => {
  const out = await captureStdout(() => reportResult(benchResult, "json"));
  assert.deepEqual(JSON.parse(out.trim()), {
    type: "bench",
    name: "list",
    status: "passed",
    durationMs: 3,
    ...benchResult.bench,
  });
});

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
