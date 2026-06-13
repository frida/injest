import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { discoverTestInfo, matchTestName } from "../src/host/source.js";

const fixture = fileURLToPath(new URL("./fixtures/discovery.fixture.ts", import.meta.url));

test("discoverTestInfo: classifies test variants and ignores non-test calls", () => {
  const tests = discoverTestInfo([fixture]);
  const summary = tests.map((t) => ({
    id: t.id,
    name: t.name,
    mode: t.mode,
    launch: t.launch,
    line: t.line,
  }));

  assert.deepEqual(summary, [
    { id: "alpha#1", name: "alpha", mode: "run", launch: "shared", line: 5 },
    { id: "beta", name: "beta", mode: "skip", launch: "shared", line: 6 },
    { id: "gamma", name: "gamma", mode: "run", launch: "isolated", line: 7 },
    { id: "delta", name: "delta", mode: "run", launch: "suspended", line: 8 },
    { id: "Group › alpha", name: "Group › alpha", mode: "run", launch: "shared", line: 11 },
    { id: "Group › nested", name: "Group › nested", mode: "run", launch: "shared", line: 12 },
    { id: "alpha#2", name: "alpha", mode: "run", launch: "shared", line: 15 },
  ]);
});

test("discoverTestInfo: index is the stable registration order", () => {
  const tests = discoverTestInfo([fixture]);
  assert.deepEqual(
    tests.map((t) => t.index),
    [0, 1, 2, 3, 4, 5, 6],
  );
});

test("discoverTestInfo: duplicate names get #n ids, unique names stay bare", () => {
  const tests = discoverTestInfo([fixture]);
  const byName = (name: string) => tests.filter((t) => t.name === name).map((t) => t.id);
  assert.deepEqual(byName("alpha"), ["alpha#1", "alpha#2"]);
  assert.deepEqual(byName("beta"), ["beta"]);
  assert.deepEqual(byName("Group › alpha"), ["Group › alpha"]);
});

test("discoverTestInfo: missing files are skipped, not fatal", () => {
  const tests = discoverTestInfo(["/no/such/file.test.ts", fixture]);
  assert.equal(tests.length, 7);
});

test("matchTestName: undefined grep matches everything", () => {
  const m = matchTestName(undefined);
  assert.equal(m("anything"), true);
});

test("matchTestName: valid regex is applied as a regex", () => {
  const m = matchTestName("^Group ›");
  assert.equal(m("Group › alpha"), true);
  assert.equal(m("alpha"), false);
});

test("matchTestName: invalid regex falls back to substring", () => {
  const m = matchTestName("a(b"); // not a valid regex
  assert.equal(m("xa(by"), true);
  assert.equal(m("nope"), false);
});
