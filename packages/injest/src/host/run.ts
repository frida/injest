import { isAbsolute, relative, resolve } from "node:path";

import type { Script, Session } from "frida";

import {
  baselineKey,
  compareBench,
  formatUs,
  type BaselineComparison,
  type BaselineEntry,
  type BaselineFile,
  type Environment,
} from "./baseline.js";

export function toProjectRelative(file: string | undefined): string | undefined {
  if (!file) return file;
  const cwd = process.cwd();
  return relative(cwd, isAbsolute(file) ? file : resolve(cwd, file));
}

export type TestStatus = "passed" | "failed" | "timeout" | "crashed" | "skipped" | "incomplete";

export interface TestError {
  name: string;
  message: string;
  stack?: string;
  expected?: string;
  actual?: string;
}

export interface BenchSamples {
  iterations: number;
  tickUs: number;
  wallUs: number[];
  userUs?: number[];
  counters: Record<string, number[]>;
}

export interface TestResult {
  index: number;
  id?: string;
  name: string;
  durationMs: number;
  status: TestStatus;
  file?: string;
  line?: number;
  error?: TestError;
  kind?: "test" | "bench";
  bench?: BenchSamples;
  baseline?: BaselineComparison;
}

export type Reporter = "pretty" | "json";

export interface BaselineOptions {
  file: BaselineFile;
  runtime: string;
  machine: string;
  timeFactor: number;
}

export interface TestMeta {
  id?: string;
  name?: string;
  file?: string;
  line?: number;
  kind?: "test" | "bench";
}

export interface RunOptions {
  timeoutMs: number;
  grep?: string;
  reporter?: Reporter;
  only?: number[];
  metaByIndex?: Map<number, TestMeta>;
  onResume?: () => Promise<void>;
  baseline?: BaselineOptions;
  onEnvironment?: (env: Environment) => void;
}

export async function runSuite(
  script: Script,
  session: Session,
  opts: RunOptions,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  let names: string[] = [];
  let total = 0;
  let current = -1;
  let currentFile: string | undefined;
  let currentLine: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let settle!: () => void;
  const finished = new Promise<void>((res) => {
    settle = res;
  });

  const finish = (): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    settle();
  };

  const reporter = opts.reporter ?? "pretty";
  let baselineEntry: BaselineEntry | undefined;
  const record = (r: TestResult): void => {
    if (r.bench && opts.baseline && baselineEntry) {
      const { machine, timeFactor } = opts.baseline;
      r.baseline = compareBench(
        r.bench,
        baselineEntry.benches[r.name],
        baselineEntry.machine === machine,
        timeFactor,
      );
      if (r.baseline.verdict === "regressed") {
        r.status = "failed";
        r.error = { name: "BaselineError", message: r.baseline.detail ?? "" };
      }
    }
    results[r.index] = r;
    reportResult(r, reporter);
  };

  const metaOf = (testIndex: unknown): TestMeta =>
    (typeof testIndex === "number" ? opts.metaByIndex?.get(testIndex) : undefined) ?? {};

  const fillRemaining = (from: number, status: TestStatus): void => {
    for (let i = from; i < total; i++) {
      if (!results[i]) {
        record({ index: i, name: names[i] ?? `#${i}`, durationMs: 0, status });
      }
    }
  };

  const onTimeout = (index: number, timeoutMs: number): void => {
    record({
      index,
      name: names[index] ?? `#${index}`,
      durationMs: timeoutMs,
      status: "timeout",
      error: { name: "TimeoutError", message: `exceeded ${timeoutMs}ms` },
    });
    fillRemaining(index + 1, "incomplete");
    // The agent thread is wedged; force-detach so we don't hang.
    session.detach().catch(() => {});
    finish();
  };

  // abnormal end: never let un-run tests look passed — mark them incomplete (which counts as failure)
  const abort = (reason: string, crashCurrent: boolean): void => {
    if (crashCurrent && current >= 0) {
      record({
        index: current,
        name: names[current] ?? `#${current}`,
        durationMs: 0,
        status: "crashed",
        error: { name: "CrashError", message: reason },
      });
    }
    fillRemaining(0, "incomplete");
    if (!results.some(Boolean)) {
      record({
        index: 0,
        name: "(suite did not run)",
        durationMs: 0,
        status: "incomplete",
        error: { name: "AbortError", message: reason },
      });
    }
    finish();
  };

  script.message.connect((message) => {
    if (message.type === "error") {
      console.error("[agent error]", message.stack ?? message.description);
      return;
    }
    if (message.type !== "send") return;
    const p = message.payload as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object" || typeof p.ft !== "string") return;

    switch (p.ft) {
      case "plan": {
        total = Number(p.total) || 0;
        names = Array.isArray(p.names) ? (p.names as string[]) : [];
        const env: Environment = { platform: String(p.platform), arch: String(p.arch) };
        opts.onEnvironment?.(env);
        if (opts.baseline) {
          const key = baselineKey(env, opts.baseline.runtime);
          baselineEntry = opts.baseline.file[key];
          if (!baselineEntry) console.error(`[injest] no baseline for ${key}; nothing to compare`);
        }
        break;
      }
      case "resume":
        Promise.resolve(opts.onResume?.())
          .catch(() => {})
          .then(() => script.post({ type: "ft:resume-ack" }));
        break;
      case "start": {
        current = Number(p.index);
        const meta = metaOf(p.testIndex);
        currentFile = meta.file;
        currentLine = meta.line;
        if (timer) clearTimeout(timer);
        const perTestTimeout =
          typeof p.timeout === "number" && p.timeout > 0 ? p.timeout : opts.timeoutMs;
        const index = Number(p.index);
        timer = setTimeout(() => onTimeout(index, perTestTimeout), perTestTimeout);
        break;
      }
      case "result": {
        if (timer) clearTimeout(timer);
        const index = Number(p.index);
        const meta = metaOf(p.testIndex);
        const name = String(p.name);
        if (meta.name !== undefined && meta.name !== name) {
          console.error(
            `[injest] selection drift at index ${Number(p.testIndex)}: ` +
              `expected "${meta.name}", agent ran "${name}"`,
          );
        }
        record({
          index,
          id: meta.id,
          name,
          durationMs: Number(p.durationMs) || 0,
          status: p.skipped ? "skipped" : p.passed ? "passed" : "failed",
          file: meta.file,
          line: meta.line,
          error: p.error as TestError | undefined,
          kind: meta.kind,
          bench: p.bench as BenchSamples | undefined,
        });
        current = -1;
        currentFile = undefined;
        currentLine = undefined;
        break;
      }
      case "done":
        finish();
        break;
    }
  });

  script.logHandler = (level, text) => {
    if (done) return;
    reportOutput(
      {
        level: String(level),
        text,
        name: current >= 0 ? names[current] : undefined,
        file: current >= 0 ? currentFile : undefined,
        line: current >= 0 ? currentLine : undefined,
      },
      reporter,
    );
  };

  session.detached.connect((reason) => {
    if (done) return; // our own teardown
    // detach before "done" means the target died mid-run
    abort(`target detached: ${reason}`, true);
  });

  const api = script.exports as unknown as {
    run(o: { grep?: string; only?: number[] }): Promise<void>;
  };
  api.run({ grep: opts.grep, only: opts.only }).catch((err: unknown) => {
    if (done) return;
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.includes("unable to find method 'run'")
      ? "the agent registered no run(): a test file threw while loading (see the agent error above)"
      : raw;
    console.error("[injest] run() failed:", message);
    abort(`run() failed: ${message}`, false);
  });

  await finished;
  fillRemaining(0, "skipped");
  return results.slice(0, Math.max(total, results.length));
}

export function reportResult(r: TestResult, reporter: Reporter): void {
  if (reporter === "json") emitJson(r);
  else printResult(r);
}

export interface OutputRecord {
  level: string;
  text: string;
  name?: string;
  file?: string;
  line?: number;
}

export function reportOutput(o: OutputRecord, reporter: Reporter): void {
  if (reporter === "json") {
    process.stdout.write(
      JSON.stringify({
        type: "output",
        level: o.level,
        text: o.text,
        name: o.name,
        file: o.file,
        line: o.line,
      }) + "\n",
    );
    return;
  }
  // pretty: indent under the running test (logs arrive before its result line)
  const prefix = "    │ ";
  process.stdout.write(
    prefix +
      o.text
        .replace(/\n$/, "")
        .split("\n")
        .join("\n" + prefix) +
      "\n",
  );
}

function printResult(r: TestResult): void {
  const detail = r.bench ? describeBench(r.bench) : `(${r.durationMs}ms)`;
  if (r.status === "passed") {
    console.log(`  ✓ ${r.name} ${detail}${baselineNote(r.baseline)}`);
    return;
  }
  if (r.status === "skipped") {
    const why = r.error ? `: ${r.error.message}` : "";
    console.log(`  - ${r.name} (skipped${why})`);
    return;
  }
  const tag = r.status === "failed" ? "" : ` [${r.status}]`;
  console.log(`  ✗ ${r.name} ${detail}${tag}`);
  if (r.error) {
    console.log(`      ${r.error.name}: ${r.error.message}`);
    if (r.error.expected !== undefined || r.error.actual !== undefined) {
      console.log(`        expected: ${indentMultiline(r.error.expected)}`);
      console.log(`        actual:   ${indentMultiline(r.error.actual)}`);
    }
    if (r.error.stack) {
      const frames = r.error.stack
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at") && !isRunnerFrame(l))
        .slice(0, 3);
      for (const f of frames) console.log(`        ${f}`);
    }
  }
}

function describeBench(b: BenchSamples): string {
  const sorted = [...b.wallUs].sort((x, y) => x - y);
  const min = sorted[0] ?? 0;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const counts = Object.entries(b.counters)
    .filter(([, values]) => values.some((v) => v !== 0))
    .map(([name, values]) => `${name}=${describeCounts(values)}`);
  const timing =
    b.iterations === 1
      ? `(${formatUs(min)}, once)`
      : `(min ${formatUs(min)}, median ${formatUs(median)}, n=${b.iterations})`;
  return [timing, ...counts].join(" ");
}

// a counter that varies between iterations is a finding in itself, so show its range
function describeCounts(values: number[]): string {
  const distinct = new Set(values);
  return distinct.size === 1 ? String(values[0]) : `${Math.min(...values)}..${Math.max(...values)}`;
}

function baselineNote(c: BaselineComparison | undefined): string {
  if (c === undefined || c.verdict === "ok" || c.verdict === "regressed") return "";
  return c.verdict === "new" ? " [new]" : ` [baseline drift: ${c.detail}]`;
}

function isRunnerFrame(frame: string): boolean {
  return /agent\/(runtime|expect)\.|[/\\]entry\.|\.injest/.test(frame);
}

function indentMultiline(value: string | undefined): string {
  return (value ?? "").split("\n").join("\n                  ");
}

function emitJson(r: TestResult): void {
  const record = {
    id: r.id,
    name: r.name,
    status: r.status,
    durationMs: r.durationMs,
    file: r.file,
    line: r.line,
    error: r.error,
  };
  process.stdout.write(
    JSON.stringify(
      r.kind === "bench"
        ? { type: "bench", ...record, ...r.bench, baseline: r.baseline }
        : { type: "test", ...record },
    ) + "\n",
  );
}

export function summarize(
  results: TestResult[],
  reporter: Reporter = "pretty",
): { passed: number; failed: number } {
  const count = (s: TestStatus): number => results.filter((r) => r.status === s).length;
  const passed = count("passed");
  const failed = count("failed") + count("timeout") + count("crashed") + count("incomplete");

  if (reporter === "json") {
    process.stdout.write(
      JSON.stringify({
        type: "end",
        passed,
        failed,
        skipped: count("skipped"),
        total: results.length,
      }) + "\n",
    );
    return { passed, failed };
  }

  const parts = [
    `${passed} passed`,
    `${count("failed")} failed`,
    `${count("timeout")} timeout`,
    `${count("crashed")} crashed`,
    `${count("incomplete")} incomplete`,
    `${count("skipped")} skipped`,
    `${results.length} total`,
  ];
  console.log(`\n${parts.join(", ")}`);
  return { passed, failed };
}
