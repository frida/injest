import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { TestResult } from "../src/host/run.js";
import { localDeviceAvailable, runFixture } from "./helpers/frida.js";

const suite = fileURLToPath(new URL("./fixtures/suite.test.ts", import.meta.url));
const timeoutFixture = fileURLToPath(new URL("./fixtures/timeout.test.ts", import.meta.url));
const hooksFixture = fileURLToPath(new URL("./fixtures/hooks.test.ts", import.meta.url));
const hookFailuresFixture = fileURLToPath(
  new URL("./fixtures/hook-failures.test.ts", import.meta.url),
);
const perTestTimeoutFixture = fileURLToPath(
  new URL("./fixtures/per-test-timeout.test.ts", import.meta.url),
);

let available = false;
before(async () => {
  available = await localDeviceAvailable();
});

const byName = (results: TestResult[]): Map<string, TestResult> =>
  new Map(results.map((r) => [r.name, r]));

test("runs a real suite in a GumJS system session", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const results = await runFixture([suite]);
  const r = byName(results);

  assert.equal(r.get("passes")?.status, "passed");
  assert.equal(r.get("async passes")?.status, "passed");
  assert.equal(r.get("throws as expected")?.status, "passed");
  assert.equal(r.get("runs inside GumJS")?.status, "passed");

  // describe nesting: the agent's registered name matches AST discovery (no drift).
  assert.equal(r.get("Group › nested passes")?.status, "passed");
  assert.equal(r.get("Group › nested passes")?.id, "Group › nested passes");
});

test("maps a failing expect to a failed result with a real diff", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const fail = byName(await runFixture([suite])).get("fails");
  assert.equal(fail?.status, "failed");
  assert.equal(fail?.error?.name, "AssertionError");
  assert.equal(fail?.error?.expected, "2");
  assert.equal(fail?.error?.actual, "1");
});

test("maps ctx.skip() and test.skip to skipped", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const r = byName(await runFixture([suite]));
  assert.equal(r.get("ctx skip")?.status, "skipped");
  assert.equal(r.get("ctx skip")?.error?.message, "nope");
  assert.equal(r.get("static skip")?.status, "skipped");
});

test("describe ctx.skip() skips the whole group, with the reason, without running bodies", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const skipped = byName(await runFixture([suite])).get(
    "Conditionally skipped › would fail if it ran",
  );
  // the body would throw on a failing expect if it ran; the group skip must short-circuit it.
  assert.equal(skipped?.status, "skipped");
  assert.equal(skipped?.error?.message, "not on this target");
});

test("a hanging test hits the per-test timeout", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const [r] = await runFixture([timeoutFixture], { timeoutMs: 300 });
  assert.equal(r.status, "timeout");
  assert.equal(r.error?.name, "TimeoutError");
});

test("beforeEach/afterEach run in nesting order around each test", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const r = byName(await runFixture([hooksFixture]));
  assert.equal(r.get("root test sees only the outer beforeEach")?.status, "passed");
  assert.equal(r.get("nested › nested test sees outer then inner beforeEach")?.status, "passed");
  assert.equal(r.get("afterEach unwinds inner before outer")?.status, "passed");
});

test("a throwing hook fails the test", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const r = byName(await runFixture([hookFailuresFixture]));
  const before = r.get("throwing beforeEach › fails before its body runs");
  assert.equal(before?.status, "failed");
  assert.equal(before?.error?.message, "before boom");

  const after = r.get("throwing afterEach › fails despite a passing body");
  assert.equal(after?.status, "failed");
  assert.equal(after?.error?.message, "after boom");
});

test("a per-test timeout overrides the larger run default", async (t) => {
  if (!available) return t.skip("no local Frida device");

  const [r] = await runFixture([perTestTimeoutFixture], { timeoutMs: 5000 });
  assert.equal(r.status, "timeout");
  assert.equal(r.error?.message, "exceeded 50ms");
});
