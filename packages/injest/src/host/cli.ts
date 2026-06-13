#!/usr/bin/env node
import { parseArgs } from "node:util";

import type { Device } from "frida";

import { compileTests, discoverTests, DEFAULT_INCLUDE } from "./bundle.js";
import {
  loadConfig,
  resolveTarget,
  type Config,
  type Runtime,
  type SessionSpec,
  type TargetConfig,
} from "./config.js";
import {
  reportResult,
  runSuite,
  summarize,
  toProjectRelative,
  type Reporter,
  type TestMeta,
  type TestResult,
} from "./run.js";
import { getDevice, openSession, runtimeOption, type OpenedSession } from "./session.js";
import { discoverTestInfo, matchTestName, type TestInfo } from "./source.js";

const DEFAULT_TIMEOUT_MS = 10000;

const EXIT_TEST_FAILURE = 1;
const EXIT_HARNESS_FAILURE = 2;

function metaByIndex(tests: TestInfo[]): Map<number, TestMeta> {
  return new Map(
    tests.map((t) => [
      t.index,
      { id: t.id, name: t.name, file: toProjectRelative(t.file), line: t.line },
    ]),
  );
}

function tryLoadConfig(path: string | undefined, required: boolean): Config | undefined {
  try {
    return loadConfig(path);
  } catch (err) {
    if (required) throw err;
    return undefined;
  }
}

function discoveryGlobs(config: Config | undefined): { include: string[]; exclude: string[] } {
  return {
    include: config?.include?.length ? config.include : DEFAULT_INCLUDE,
    exclude: config?.exclude ?? [],
  };
}

function printHelp(): void {
  console.log(`injest — run tests inside a Frida GumJS target

Usage:
  injest [file-filters...] [options]

Test files match the "include" globs in injest.config.json
(default: tests/**/*.test.{ts,js}). Positional args filter those by path substring.

Options:
  --target <name>          target profile from injest.config.json (else "default")
  -c, --config <path>      config file (default: ./injest.config.json)
  -t, --testNamePattern <re>  run only tests whose name matches the regex
  --only <id>              run only the test(s) with this stable id (repeatable)
  --reporter <pretty|json> output format; json emits NDJSON on stdout (default: pretty)
  --list                   list discovered tests (id, location) without running
  -h, --help               show this help

In code:
  test(name, fn, { timeout })   test.skip(name, fn)   describe(label, fn)
  beforeEach(fn) / afterEach(fn)     run around each test in the enclosing describe
  test.isolated(name, fn)            own fresh process, killed after (spawn targets)
  test.suspended(name, async ({ resume }) => …)   spawn suspended; resume() releases it

Examples:
  injest --target local                  run all tests on the local system session
  injest foo -t bar                       files matching "foo", tests matching /bar/
  injest --target <name>                  run against a configured target
  injest --list                           list tests without running
  injest --reporter json > results.ndjson

Runtime (qjs|v8) and per-test timeout (ms, default 10000) are set per target in
injest.config.json.`);
}

function describeSession(session: SessionSpec): string {
  return session === "system" ? "system" : `spawn(${session.spawn})`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string" },
      config: { type: "string", short: "c" },
      testNamePattern: { type: "string", short: "t" },
      only: { type: "string", multiple: true },
      reporter: { type: "string" },
      list: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const reporter = values.reporter === "json" ? "json" : "pretty";

  const configRequired = !values.list;
  const config = tryLoadConfig(values.config, configRequired);

  const { include, exclude } = discoveryGlobs(config);
  let files = discoverTests({ include, exclude });
  if (positionals.length > 0) {
    files = files.filter((f) => positionals.some((p) => f.includes(p)));
  }
  if (files.length === 0) {
    const where = positionals.length ? ` matching ${positionals.join(", ")}` : "";
    throw new Error(`no test files found${where} (include: ${include.join(", ")})`);
  }

  const matches = matchTestName(values.testNamePattern);
  let tests = discoverTestInfo(files).filter((t) => matches(t.name));
  if (values.only) {
    const want = new Set(values.only);
    tests = tests.filter((t) => want.has(t.id));
  }
  if (values.list) {
    printList(tests, reporter);
    return;
  }

  const { name, target } = resolveTarget(config!, values.target);

  console.error(`[injest] running ${files.length} test file(s)`);
  const source = await compileTests(files);

  const deviceLabel = typeof target.device === "object" ? `id(${target.device.id})` : target.device;
  console.error(
    `[injest] target "${name}" -> device=${deviceLabel} session=${describeSession(target.session)}`,
  );

  const device = await getDevice(target);

  const runtime = target.runtime ?? "qjs";
  const timeoutMs = target.timeout ?? DEFAULT_TIMEOUT_MS;
  const failed = await runOnce(device, target, source, runtime, { timeoutMs, reporter, tests });
  if (failed > 0) process.exitCode = EXIT_TEST_FAILURE;
}

interface RunOnceOptions {
  timeoutMs: number;
  reporter: Reporter;
  tests: TestInfo[];
}

async function runOnce(
  device: Device,
  target: TargetConfig,
  source: string,
  runtime: Runtime,
  opts: RunOnceOptions,
): Promise<number> {
  const reporter = opts.reporter;
  const spawnable = typeof target.session === "object" && "spawn" in target.session;

  const primary = await openSession(device, target);
  let primaryScript;
  try {
    primaryScript = await primary.session.createScript(source, {
      runtime: runtimeOption(runtime),
    });
    await primaryScript.load();
  } catch (e) {
    await closeCapped(primary);
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[injest] runtime ${runtime} unavailable on this target: ${msg}`);
    return 0; // a runtime the target lacks is a skip, not a failure
  }
  console.error(`[injest] runtime=${runtime}`);

  const all = opts.tests;
  const isolated = all.filter(
    (t) => (t.launch === "isolated" || t.launch === "suspended") && t.mode !== "skip",
  );
  const isolatedIndices = new Set(isolated.map((t) => t.index));
  const sharedIndices = all.filter((t) => !isolatedIndices.has(t.index)).map((t) => t.index);

  if (reporter === "json") {
    process.stdout.write(JSON.stringify({ type: "start", total: all.length }) + "\n");
  }

  const subOpts = {
    timeoutMs: opts.timeoutMs,
    reporter,
    metaByIndex: metaByIndex(all),
  };
  const results: TestResult[] = [];

  if (spawnable) await primary.resume();
  results.push(
    ...(await runSuite(primaryScript, primary.session, {
      ...subOpts,
      only: sharedIndices,
      onResume: primary.resume,
    })),
  );
  await closeCapped(primary);

  for (const t of isolated) {
    if (!spawnable) {
      const r: TestResult = {
        index: results.length,
        id: t.id,
        name: t.name,
        durationMs: 0,
        status: "skipped",
        file: toProjectRelative(t.file),
        line: t.line,
        error: { name: "Skipped", message: `requires a spawnable target (launch: ${t.launch})` },
      };
      reportResult(r, reporter ?? "pretty");
      results.push(r);
      continue;
    }
    const iso = await openSession(device, target);
    const script = await iso.session.createScript(source, { runtime: runtimeOption(runtime) });
    await script.load();
    // isolated resumes now; suspended stays gated and resumes itself mid-test via ctx.resume()
    if (t.launch === "isolated") await iso.resume();
    results.push(
      ...(await runSuite(script, iso.session, {
        ...subOpts,
        only: [t.index],
        onResume: iso.resume,
      })),
    );
    await closeCapped(iso);
  }

  const { failed } = summarize(results, reporter ?? "pretty");
  return failed;
}

/** Best-effort teardown, capped: a wedged session can make close() block forever. */
async function closeCapped(opened: OpenedSession): Promise<void> {
  await Promise.race([opened.close().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
}

function printList(tests: TestInfo[], reporter: Reporter): void {
  const located = tests.map((t) => ({ ...t, file: toProjectRelative(t.file) }));
  if (reporter === "json") {
    process.stdout.write(JSON.stringify({ type: "list", tests: located }) + "\n");
    return;
  }
  for (const t of located) {
    const loc = t.file ? ` (${t.file}:${t.line ?? "?"})` : "";
    const tags =
      (t.mode === "run" ? "" : ` [${t.mode}]`) + (t.launch === "shared" ? "" : ` [${t.launch}]`);
    console.log(`  ${t.id}${loc}${tags}`);
  }
  console.log(`\n${tests.length} test(s)`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[injest] error:", message);
    process.exit(EXIT_HARNESS_FAILURE);
  },
);
