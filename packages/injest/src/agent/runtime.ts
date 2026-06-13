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

type Thunk = () => void | Promise<void>;

interface Suite {
  parent: Suite | null;
  beforeEach: Thunk[];
  afterEach: Thunk[];
}

interface TestCase {
  name: string;
  fn: Thunk;
  mode: Mode;
  launch: Launch;
  suite: Suite;
  timeout?: number;
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
const rootSuite: Suite = { parent: null, beforeEach: [], afterEach: [] };
let currentSuite = rootSuite;

function add(name: string, fn: Thunk, mode: Mode, opts?: TestOptions): void {
  const qualifiedName = [...suiteStack, name].join(" › ");
  registry.push({
    name: qualifiedName,
    fn,
    mode,
    launch: opts?.launch ?? "shared",
    suite: currentSuite,
    timeout: opts?.timeout,
  });
}

export function describe(label: string, fn: () => void): void {
  suiteStack.push(label);
  const parent = currentSuite;
  currentSuite = { parent, beforeEach: [], afterEach: [] };
  try {
    fn();
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
  });
  for (let i = 0; i < selected.length; i++) {
    const { test: t, testIndex } = selected[i];
    send({ ft: "start", index: i, testIndex, name: t.name, timeout: t.timeout });
    if (t.mode === "skip") {
      send({
        ft: "result",
        index: i,
        testIndex,
        name: t.name,
        passed: true,
        skipped: true,
        durationMs: 0,
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
      send({ ft: "result", index: i, testIndex, name: t.name, passed: true, durationMs });
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
