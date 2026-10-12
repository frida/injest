/// <reference types="frida-gum" />

import { AssertionError } from "./expect.js";

export { expect } from "./expect.js";

export interface TestContext {
  skip: (reason?: string) => never;
}

export type TestFn = (ctx: TestContext) => void | Promise<void>;

export interface SuspendedContext extends TestContext {
  resume: () => Promise<void>;
}

export type SuspendedFn = (ctx: SuspendedContext) => void | Promise<void>;

export interface SuiteContext {
  skip: (reason?: string) => void;
}

export type SuiteFn = (ctx: SuiteContext) => void;

class SkipSignal {
  constructor(readonly reason?: string) {}
}

function skip(reason?: string): never {
  throw new SkipSignal(reason);
}

export type Launch = "shared" | "isolated" | "suspended";

type Mode = "run" | "skip";

export interface TestOptions {
  launch?: Launch;
  timeout?: number;
}

export interface BenchOptions extends TestOptions {
  warmup?: number;
  iterations?: number;
}

export interface BenchContext extends TestContext {
  measure: (body: () => unknown) => Promise<void>;
}

export type BenchFn = (ctx: BenchContext) => void | Promise<void>;

export interface BenchSamples {
  iterations: number;
  wallUs: number[];
  userUs?: number[];
  counters: Record<string, number[]>;
}

type Thunk = () => void | Promise<void>;

interface Suite {
  parent: Suite | null;
  beforeEach: Thunk[];
  afterEach: Thunk[];
  skipped: boolean;
  skipReason?: string;
}

interface TestCase {
  name: string;
  fn: Thunk;
  mode: Mode;
  launch: Launch;
  suite: Suite;
  timeout?: number;
  samples?: BenchSamples;
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  expected?: string;
  actual?: string;
}

export interface RunOptions {
  grep?: string;
  only?: number[];
}

const registry: TestCase[] = [];
const suiteStack: string[] = [];
const rootSuite: Suite = { parent: null, beforeEach: [], afterEach: [], skipped: false };
let currentSuite = rootSuite;

function add(name: string, fn: Thunk, mode: Mode, opts?: TestOptions): TestCase {
  const qualifiedName = [...suiteStack, name].join(" › ");
  const entry: TestCase = {
    name: qualifiedName,
    fn,
    mode,
    launch: opts?.launch ?? "shared",
    suite: currentSuite,
    timeout: opts?.timeout,
  };
  registry.push(entry);
  return entry;
}

export function describe(label: string, fn: SuiteFn): void {
  suiteStack.push(label);
  const parent = currentSuite;
  const suite: Suite = { parent, beforeEach: [], afterEach: [], skipped: false };
  currentSuite = suite;
  const ctx: SuiteContext = {
    skip: (reason) => {
      suite.skipped = true;
      suite.skipReason = reason;
    },
  };
  try {
    fn(ctx);
  } finally {
    currentSuite = parent;
    suiteStack.pop();
  }
}

export function beforeEach(fn: Thunk): void {
  currentSuite.beforeEach.push(fn);
}

export function afterEach(fn: Thunk): void {
  currentSuite.afterEach.push(fn);
}

// a test is skipped if its suite, or any ancestor, was skipped via the describe ctx;
// the nearest such reason wins
function skipFor(suite: Suite): { skipped: boolean; reason?: string } {
  for (let s: Suite | null = suite; s; s = s.parent) {
    if (s.skipped) return { skipped: true, reason: s.skipReason };
  }
  return { skipped: false };
}

function hooksFor(suite: Suite): { runBefore: Thunk[]; runAfter: Thunk[] } {
  const outerToInner: Suite[] = [];
  for (let s: Suite | null = suite; s; s = s.parent) outerToInner.unshift(s);
  const innerToOuter = [...outerToInner].reverse();
  return {
    runBefore: outerToInner.flatMap((s) => s.beforeEach),
    runAfter: innerToOuter.flatMap((s) => s.afterEach),
  };
}

const baseContext: TestContext = { skip };
const suspendedContext: SuspendedContext = { skip, resume };

export const test = Object.assign(
  (name: string, fn: TestFn, opts?: TestOptions) => add(name, () => fn(baseContext), "run", opts),
  {
    skip: (name: string, fn: TestFn, opts?: TestOptions) =>
      add(name, () => fn(baseContext), "skip", opts),
    isolated: (name: string, fn: TestFn, opts?: TestOptions) =>
      add(name, () => fn(baseContext), "run", { ...opts, launch: "isolated" }),
    suspended: (name: string, fn: SuspendedFn, opts?: TestOptions) =>
      add(name, () => fn(suspendedContext), "run", { ...opts, launch: "suspended" }),
  },
);

const DEFAULT_WARMUP = 2;
const DEFAULT_ITERATIONS = 10;

export const bench = Object.assign(
  (name: string, fn: BenchFn, opts?: BenchOptions) => addBench(name, fn, opts),
  {
    isolated: (name: string, fn: BenchFn, opts?: BenchOptions) =>
      addBench(name, fn, { ...opts, launch: "isolated" }),
  },
);

function addBench(name: string, fn: BenchFn, opts?: BenchOptions): void {
  const warmup = opts?.warmup ?? DEFAULT_WARMUP;
  const iterations = opts?.iterations ?? DEFAULT_ITERATIONS;
  const entry = add(
    name,
    async () => {
      entry.samples = await runBench(fn, warmup, iterations);
    },
    "run",
    opts,
  );
}

async function runBench(fn: BenchFn, warmup: number, iterations: number): Promise<BenchSamples> {
  const runs: Promise<BenchSamples>[] = [];
  const measure = (body: () => unknown): Promise<void> => {
    const run = sample(body, warmup, iterations);
    runs.push(run);
    const settled = run.then(() => undefined);
    settled.catch(() => {}); // the failure surfaces through Promise.all below even if unawaited
    return settled;
  };
  await fn({ skip, measure });
  const samples = await Promise.all(runs);
  if (samples.length !== 1) {
    throw new Error(
      `a bench calls measure(body) exactly once; this one called it ${samples.length} times`,
    );
  }
  return samples[0];
}

interface Counter {
  name: string;
  read: () => number;
}

const counters: Counter[] = [];

export function counter(name: string, target: object, method: string): void;
export function counter(name: string, fn: NativePointer): void;
export function counter(name: string, target: object, method?: string): void {
  if (counters.some((c) => c.name === name)) {
    throw new Error(`counter ${name} is already registered`);
  }
  if (method === undefined) {
    if (typeof CallCountSampler === "undefined") {
      throw new Error(`counter ${name}: counting native calls needs a Frida with CallCountSampler`);
    }
    const sampler = new CallCountSampler([target as NativePointer]);
    counters.push({ name, read: () => Number(sampler.sample()) });
    return;
  }
  const host = target as Record<string, (...args: unknown[]) => unknown>;
  const original = host[method];
  if (typeof original !== "function") {
    throw new Error(`counter ${name}: ${method} is not a method of the given object`);
  }
  let calls = 0;
  try {
    host[method] = function (this: unknown, ...args: unknown[]) {
      calls++;
      return original.apply(this, args);
    };
  } catch {
    throw new Error(
      `counter ${name}: ${method} is read-only on its object; count a native function instead`,
    );
  }
  counters.push({ name, read: () => calls });
}

let samplers: { wall: Sampler | null; user: Sampler | null } | undefined;

function benchSamplers(): { wall: Sampler | null; user: Sampler | null } {
  samplers ??= {
    wall: typeof WallClockSampler !== "undefined" ? new WallClockSampler() : null,
    user: typeof UserTimeSampler !== "undefined" ? new UserTimeSampler() : null,
  };
  return samplers;
}

async function sample(
  body: () => unknown,
  warmup: number,
  iterations: number,
): Promise<BenchSamples> {
  const { wall, user } = benchSamplers();
  const wallNow = (): number => (wall !== null ? Number(wall.sample()) : Date.now() * 1000);
  for (let i = 0; i < warmup; i++) {
    const r = body();
    if (r instanceof Promise) await r;
  }
  const wallUs: number[] = [];
  const userUs: number[] = [];
  const counts = counters.map((): number[] => []);
  for (let i = 0; i < iterations; i++) {
    const before = counters.map((c) => c.read());
    const user0 = user?.sample();
    const wall0 = wallNow();
    const r = body();
    if (r instanceof Promise) await r;
    wallUs.push(wallNow() - wall0);
    if (user !== null) userUs.push(Number(user.sample() - (user0 as bigint)));
    counters.forEach((c, k) => counts[k].push(c.read() - before[k]));
  }
  return {
    iterations,
    wallUs,
    userUs: user !== null ? userUs : undefined,
    counters: Object.fromEntries(counters.map((c, k) => [c.name, counts[k]])),
  };
}

function resume(): Promise<void> {
  return new Promise<void>((resolve) => {
    recv("ft:resume-ack", () => resolve());
    send({ ft: "resume" });
  });
}

export async function run(options: RunOptions = {}): Promise<void> {
  const indexed = registry.map((test, testIndex) => ({ test, testIndex }));
  let selected: { test: TestCase; testIndex: number }[];
  if (options.only) {
    const want = new Set(options.only);
    selected = indexed.filter((e) => want.has(e.testIndex));
  } else {
    const matches = makeMatcher(options.grep);
    selected = indexed.filter((e) => matches(e.test.name));
  }

  send({
    ft: "plan",
    total: selected.length,
    names: selected.map((e) => e.test.name),
    indices: selected.map((e) => e.testIndex),
    platform: Process.platform,
    arch: Process.arch,
  });
  for (let i = 0; i < selected.length; i++) {
    const { test: t, testIndex } = selected[i];
    send({ ft: "start", index: i, testIndex, name: t.name, timeout: t.timeout });
    const suiteSkip = skipFor(t.suite);
    if (t.mode === "skip" || suiteSkip.skipped) {
      send({
        ft: "result",
        index: i,
        testIndex,
        name: t.name,
        passed: true,
        skipped: true,
        durationMs: 0,
        error: suiteSkip.reason ? { name: "Skipped", message: suiteSkip.reason } : undefined,
      });
      continue;
    }

    const { runBefore, runAfter } = hooksFor(t.suite);
    const start = Date.now();
    let failure: unknown;
    let skipSignal: SkipSignal | undefined;
    try {
      for (const hook of runBefore) await hook();
      await t.fn();
    } catch (e) {
      if (e instanceof SkipSignal) skipSignal = e;
      else failure = e;
    }
    for (const hook of runAfter) {
      try {
        await hook();
      } catch (e) {
        failure ??= e;
      }
    }

    const durationMs = Date.now() - start;
    if (failure !== undefined) {
      send({
        ft: "result",
        index: i,
        testIndex,
        name: t.name,
        passed: false,
        durationMs,
        error: serializeError(failure),
      });
    } else if (skipSignal) {
      send({
        ft: "result",
        index: i,
        testIndex,
        name: t.name,
        passed: true,
        skipped: true,
        durationMs,
        error: skipSignal.reason ? { name: "Skipped", message: skipSignal.reason } : undefined,
      });
    } else {
      send({
        ft: "result",
        index: i,
        testIndex,
        name: t.name,
        passed: true,
        durationMs,
        bench: t.samples,
      });
    }
  }
  send({ ft: "done", total: selected.length });
}

function makeMatcher(grep?: string): (name: string) => boolean {
  if (!grep) return () => true;
  try {
    const re = new RegExp(grep);
    return (name) => re.test(name);
  } catch {
    return (name) => name.includes(grep);
  }
}

function serializeError(e: unknown): SerializedError {
  if (e instanceof AssertionError) {
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      expected: e.expected,
      actual: e.actual,
    };
  }
  if (e instanceof Error) {
    return { name: e.name || "Error", message: e.message, stack: e.stack };
  }
  return { name: "Error", message: String(e) };
}
