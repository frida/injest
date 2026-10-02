import { test, expect } from "@frida/injest/agent";

test("compiles under a library tsconfig", () => {
  expect(Process.pointerSize).toBeGreaterThan(0);
});
