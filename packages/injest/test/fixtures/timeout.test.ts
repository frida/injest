/// <reference types="frida-gum" />
// Single never-resolving test: exercises runSuite's per-test timeout + force-detach.
import { test } from "@frida/injest/agent";

test("hangs forever", async () => {
  await new Promise<void>(() => {});
});
