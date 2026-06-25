/// <reference types="frida-gum" />
import { test } from "@frida/injest/agent";

test(
  "hangs until its short per-test timeout fires",
  async () => {
    await new Promise<void>(() => {});
  },
  { timeout: 50 },
);
