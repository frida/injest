/// <reference types="frida-gum" />
// Single never-resolving test: exercises runSuite's per-test timeout + force-detach.
import { test } from "injest/agent";

test("hangs forever", async () => {
  await new Promise<void>(() => {});
});
