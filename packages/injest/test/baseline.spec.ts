import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  baselineKey,
  compareBench,
  loadBaseline,
  saveBaseline,
  summarizeBench,
  updateBaseline,
} from "../src/host/baseline.js";
import type { BenchSamples, TestResult } from "../src/host/run.js";

const samples: BenchSamples = {
  iterations: 3,
  wallUs: [1200, 900, 1000],
  counters: { tables: [1, 1, 1], calls: [82, 83, 82] },
};
const base = summarizeBench(samples);

const withCounters = (
  counters: Record<string, number[]>,
  wallUs = samples.wallUs,
): BenchSamples => ({
  iterations: 3,
  wallUs,
  counters,
});

test("summarizeBench: a counter at its worst iteration, wall min and median", () => {
  assert.deepEqual(base, {
    counters: { tables: 1, calls: 83 },
    wallUs: { min: 900, median: 1000 },
  });
});

test("baselineKey: platform, arch and runtime", () => {
  assert.equal(baselineKey({ platform: "darwin", arch: "arm64" }, "qjs"), "darwin-arm64-qjs");
});

test("compareBench: no entry is new, equal counts are ok", () => {
  assert.deepEqual(compareBench(samples, undefined, true, 3), { verdict: "new" });
  assert.deepEqual(compareBench(samples, base, true, 3), { verdict: "ok" });
});

test("compareBench: a count above the baseline regresses, by however little", () => {
  const c = compareBench(withCounters({ tables: [1, 1, 1], calls: [82, 84, 82] }), base, false, 3);
  assert.deepEqual(c, { verdict: "regressed", detail: "calls 84 > 83" });
});

test("compareBench: a lower or unbaselined count drifts without failing", () => {
  const c = compareBench(
    withCounters({ tables: [0, 0, 0], calls: [83, 83, 83], scans: [2, 2, 2] }),
    base,
    false,
    3,
  );
  assert.deepEqual(c, { verdict: "drifted", detail: "tables 0 < 1, scans not in baseline" });
});

test("compareBench: time counts only on the machine that set the baseline", () => {
  const slow = withCounters(samples.counters, [4000, 3000, 3500]);
  assert.deepEqual(compareBench(slow, base, false, 3), { verdict: "ok" });
  assert.deepEqual(compareBench(slow, base, true, 3), {
    verdict: "regressed",
    detail: "min 3.0ms > 3× 900µs",
  });
  assert.deepEqual(compareBench(slow, base, true, 4), { verdict: "ok" });
});

test("updateBaseline: replaces the benches that ran and keeps the rest of the entry", () => {
  const file = {
    "darwin-arm64-qjs": {
      machine: "old",
      benches: { a: base, kept: base },
    },
  };
  const ran: TestResult[] = [
    {
      index: 0,
      name: "a",
      durationMs: 1,
      status: "passed",
      bench: withCounters({ tables: [2, 2, 2] }),
    },
    { index: 1, name: "failed", durationMs: 1, status: "failed" },
  ];
  const updated = updateBaseline(file, "darwin-arm64-qjs", "new", ran);
  assert.deepEqual(Object.keys(updated["darwin-arm64-qjs"].benches), ["a", "kept"]);
  assert.equal(updated["darwin-arm64-qjs"].machine, "new");
  assert.deepEqual(updated["darwin-arm64-qjs"].benches.a.counters, { tables: 2 });
  assert.deepEqual(updated["darwin-arm64-qjs"].benches.kept, base);
  assert.equal(file["darwin-arm64-qjs"].machine, "old");
});

test("loadBaseline: a missing file is an error unless it is about to be written", () => {
  const path = join(mkdtempSync(join(tmpdir(), "injest-baseline-")), "baseline.json");
  assert.throws(() => loadBaseline(path, false), /baseline not found/);
  assert.deepEqual(loadBaseline(path, true), {});
  const file = updateBaseline({}, "linux-x64-v8", "ci", [
    { index: 0, name: "a", durationMs: 1, status: "passed", bench: samples },
  ]);
  saveBaseline(path, file);
  assert.deepEqual(loadBaseline(path, false), file);
});
