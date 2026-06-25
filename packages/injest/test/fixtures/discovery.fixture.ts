// Fixture parsed by source.spec.ts via discoverTestInfo(). Line numbers are
// asserted there, so keep additions at the bottom and don't reflow this file.
import { test, describe } from "@frida/injest/agent";

test("alpha", () => {});
test.skip("beta", () => {});
test.isolated("gamma", () => {});
test.suspended("delta", async () => {});

describe("Group", () => {
  test("alpha", () => {});
  test("nested", () => {});
});

test("alpha", () => {});

// Not a recognized test/describe call — must be ignored by discovery.
notTest("ignored", () => {});
