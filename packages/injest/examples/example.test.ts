/// <reference types="frida-gum" />
import { test, expect, describe, beforeEach, afterEach } from "@frida/injest/agent";

// Normal tests share a session/spawn
test("arithmetic works in GumJS", () => {
  expect(1 + 1).toBe(2);
});

test(
  "has a generous per-test timeout",
  async () => {
    await new Promise((r) => setTimeout(r, 50));
    expect(true).toBeTruthy();
  },
  { timeout: 30000 },
);

test("deep equality", () => {
  expect({ a: [1, 2], b: "x" }).toEqual({ a: [1, 2], b: "x" });
});

test("runs inside a Frida runtime", () => {
  expect(typeof Frida.version).toBe("string");
  expect(Process.id > 0).toBeTruthy();
});

// Can skip
test("uses an Apple-silicon-only feature", ({ skip }) => {
  if (Process.platform !== "darwin" || Process.arch !== "arm64") {
    skip("Unsuppoted platform");
  }
  expect(Process.pointerSize).toBe(8);
});

test("async test", async () => {
  const v = await Promise.resolve(42);
  expect(v).toBe(42);
});

// Isolated and suspended tests are a spawn per test
test.isolated("runs in its own fresh process", () => {
  const main = Process.mainModule;
  expect(typeof main.name).toBe("string");
  expect(main.enumerateExports().length >= 0).toBeTruthy();
});

// Suspended tests have a resume
test.suspended("a hook is in place before the app starts", async ({ resume }) => {
  const open = Module.getGlobalExportByName("open");
  const fired = new Promise<void>((done) => {
    Interceptor.attach(open, { onEnter: () => done() });
  });
  await resume();
  await fired;
});

describe("Interceptor", () => {
  let open: NativePointer;
  beforeEach(() => {
    open = Module.getGlobalExportByName("open");
  });
  afterEach(() => {
    Interceptor.revert(open);
  });

  test("can attach and detach cleanly", () => {
    Interceptor.attach(open, { onEnter() {} });
    expect(typeof open.toString()).toBe("string");
  });
});
