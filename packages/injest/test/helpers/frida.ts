import { compileTests } from "../../src/host/bundle.js";
import { runSuite, toProjectRelative, type TestResult } from "../../src/host/run.js";
import { getDevice, openSession, runtimeOption } from "../../src/host/session.js";
import { discoverTestInfo } from "../../src/host/source.js";
import type { Runtime, TargetConfig } from "../../src/host/config.js";
import { captureStdout } from "./capture.js";

const TARGET: TargetConfig = { device: "local", session: "system" };

export async function localDeviceAvailable(): Promise<boolean> {
  try {
    await getDevice(TARGET);
    return true;
  } catch {
    return false;
  }
}

export async function runFixture(
  files: string[],
  opts: { timeoutMs?: number; runtime?: Runtime } = {},
): Promise<TestResult[]> {
  const tests = discoverTestInfo(files);
  const source = await compileTests(files);
  const device = await getDevice(TARGET);
  const opened = await openSession(device, TARGET);

  let results: TestResult[] = [];
  try {
    const script = await opened.session.createScript(source, {
      runtime: runtimeOption(opts.runtime),
    });
    await script.load();

    const metaByIndex = new Map(
      tests.map((t) => [
        t.index,
        { id: t.id, name: t.name, file: toProjectRelative(t.file), line: t.line },
      ]),
    );
    // A system session can't spawn, so isolated/suspended tests are excluded.
    const indices = tests
      .filter((t) => t.launch === "shared" || t.mode === "skip")
      .map((t) => t.index);

    await captureStdout(async () => {
      results = await runSuite(script, opened.session, {
        timeoutMs: opts.timeoutMs ?? 5000,
        reporter: "json",
        metaByIndex,
        only: indices,
      });
    });
  } finally {
    await opened.close().catch(() => {});
  }
  return results;
}
