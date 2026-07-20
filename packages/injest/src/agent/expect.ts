import deepEqual from "deep-eql";

export class AssertionError extends Error {
  readonly expected?: string;
  readonly actual?: string;
  readonly operator?: string;
  readonly showDiff: boolean;

  constructor(message: string, detail?: { expected: unknown; actual: unknown; operator: string }) {
    super(message);
    this.name = "AssertionError";
    if (detail) {
      this.expected = fmtDiff(detail.expected);
      this.actual = fmtDiff(detail.actual);
      this.operator = detail.operator;
      this.showDiff = true;
    } else {
      this.showDiff = false;
    }
  }
}

export type ThrowMatcher = string | RegExp | (new (...args: never[]) => unknown) | Error;

export interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeNaN(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toBeCloseTo(n: number, numDigits?: number): void;
  toContain(item: unknown): void;
  toMatch(expected: string | RegExp): void;
  toHaveLength(length: number): void;
  toThrow(expected?: ThrowMatcher): void;
  readonly not: Matchers;
  readonly rejects: AsyncMatchers;
  readonly resolves: AsyncMatchers;
}

export interface AsyncMatchers {
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toBeTruthy(): Promise<void>;
  toBeFalsy(): Promise<void>;
  toBeNull(): Promise<void>;
  toBeUndefined(): Promise<void>;
  toBeDefined(): Promise<void>;
  toBeNaN(): Promise<void>;
  toBeGreaterThan(n: number): Promise<void>;
  toBeGreaterThanOrEqual(n: number): Promise<void>;
  toBeLessThan(n: number): Promise<void>;
  toBeLessThanOrEqual(n: number): Promise<void>;
  toBeCloseTo(n: number, numDigits?: number): Promise<void>;
  toContain(item: unknown): Promise<void>;
  toMatch(expected: string | RegExp): Promise<void>;
  toHaveLength(length: number): Promise<void>;
  toThrow(expected?: ThrowMatcher): Promise<void>;
  readonly not: AsyncMatchers;
}

export function expect(actual: unknown): Matchers {
  return makeMatchers(actual, false);
}

function makeMatchers(actual: unknown, negated: boolean): Matchers {
  const check = (
    pass: boolean,
    summary: string,
    detail?: { expected: unknown; actual: unknown; operator: string },
  ): void => {
    if (pass !== negated) return;
    const verb = negated ? `not ${summary}` : summary;
    throw new AssertionError(`expected ${fmt(actual)} ${verb}`, negated ? undefined : detail);
  };

  const asNumber = (): number => {
    if (typeof actual !== "number") {
      throw new AssertionError(`expected a number, got ${fmt(actual)}`);
    }
    return actual;
  };

  return {
    toBe(expected) {
      check(actual === expected, `to be ${fmt(expected)}`, { expected, actual, operator: "toBe" });
    },
    toEqual(expected) {
      check(
        deepEqual(actual, expected, { comparator: compareGumValues }),
        `to equal ${fmt(expected)}`,
        {
          expected,
          actual,
          operator: "toEqual",
        },
      );
    },
    toBeTruthy() {
      check(!!actual, "to be truthy");
    },
    toBeFalsy() {
      check(!actual, "to be falsy");
    },
    toBeNull() {
      check(actual === null, "to be null");
    },
    toBeUndefined() {
      check(actual === undefined, "to be undefined");
    },
    toBeDefined() {
      check(actual !== undefined, "to be defined");
    },
    toBeNaN() {
      check(typeof actual === "number" && Number.isNaN(actual), "to be NaN");
    },
    toBeGreaterThan(n) {
      check(asNumber() > n, `to be greater than ${fmt(n)}`);
    },
    toBeGreaterThanOrEqual(n) {
      check(asNumber() >= n, `to be greater than or equal to ${fmt(n)}`);
    },
    toBeLessThan(n) {
      check(asNumber() < n, `to be less than ${fmt(n)}`);
    },
    toBeLessThanOrEqual(n) {
      check(asNumber() <= n, `to be less than or equal to ${fmt(n)}`);
    },
    toBeCloseTo(n, numDigits = 2) {
      const tolerance = Math.pow(10, -numDigits) / 2;
      check(Math.abs(asNumber() - n) < tolerance, `to be close to ${fmt(n)} (±${tolerance})`);
    },
    toContain(item) {
      if (typeof actual !== "string" && !Array.isArray(actual)) {
        throw new AssertionError(`toContain() expects a string or array, got ${fmt(actual)}`);
      }
      const has =
        typeof actual === "string" ? actual.includes(String(item)) : actual.includes(item);
      check(has, `to contain ${fmt(item)}`);
    },
    toMatch(expected) {
      if (typeof actual !== "string") {
        throw new AssertionError(`toMatch() expects a string, got ${fmt(actual)}`);
      }
      const matched =
        expected instanceof RegExp ? expected.test(actual) : actual.includes(expected);
      check(matched, `to match ${describeMatch(expected)}`);
    },
    toHaveLength(length) {
      const len = (actual as { length?: unknown } | null | undefined)?.length;
      if (typeof len !== "number") {
        throw new AssertionError(
          `toHaveLength() expects a value with a numeric length, got ${fmt(actual)}`,
        );
      }
      check(len === length, `to have length ${fmt(length)} (got ${len})`);
    },
    toThrow(expected) {
      if (typeof actual !== "function") {
        throw new AssertionError("toThrow() expects a function");
      }
      let thrown: unknown;
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch (e) {
        threw = true;
        thrown = e;
      }
      checkThrow("function", threw, thrown, expected, negated);
    },
    get not() {
      return makeMatchers(actual, !negated);
    },
    get rejects() {
      return makeAsync(actual, true, negated);
    },
    get resolves() {
      return makeAsync(actual, false, negated);
    },
  };
}

type GumValueKind = "int64" | "uint64" | "pointer";

function gumValueKind(value: unknown): GumValueKind | null {
  if (value === null || typeof value !== "object") return null;
  if (typeof Int64 !== "undefined" && value instanceof Int64) return "int64";
  if (typeof UInt64 !== "undefined" && value instanceof UInt64) return "uint64";
  if (typeof NativePointer !== "undefined" && value instanceof NativePointer) return "pointer";
  return null;
}

function compareGumValues(left: unknown, right: unknown): boolean | null {
  const leftKind = gumValueKind(left);
  const rightKind = gumValueKind(right);
  if (leftKind === null && rightKind === null) return null;
  if (leftKind !== rightKind) return false;

  switch (leftKind) {
    case "int64":
      return (left as Int64).equals(right as Int64);
    case "uint64":
      return (left as UInt64).equals(right as UInt64);
    case "pointer":
      return (left as NativePointer).equals(right as NativePointer);
    default:
      return false;
  }
}

function makeAsync(subject: unknown, expectRejection: boolean, negated: boolean): AsyncMatchers {
  const settle = async (): Promise<unknown> => {
    let value: unknown;
    let reason: unknown;
    let threw = false;
    try {
      value = await (subject as Promise<unknown>);
    } catch (e) {
      threw = true;
      reason = e;
    }
    if (expectRejection && !threw) {
      throw new AssertionError(`expected promise to reject, but it resolved with ${fmt(value)}`);
    }
    if (!expectRejection && threw) {
      throw new AssertionError(`expected promise to resolve, but it rejected with ${fmt(reason)}`);
    }
    return expectRejection ? reason : value;
  };
  const settled = async (): Promise<Matchers> => makeMatchers(await settle(), negated);

  return {
    toBe: async (expected) => (await settled()).toBe(expected),
    toEqual: async (expected) => (await settled()).toEqual(expected),
    toBeTruthy: async () => (await settled()).toBeTruthy(),
    toBeFalsy: async () => (await settled()).toBeFalsy(),
    toBeNull: async () => (await settled()).toBeNull(),
    toBeUndefined: async () => (await settled()).toBeUndefined(),
    toBeDefined: async () => (await settled()).toBeDefined(),
    toBeNaN: async () => (await settled()).toBeNaN(),
    toBeGreaterThan: async (n) => (await settled()).toBeGreaterThan(n),
    toBeGreaterThanOrEqual: async (n) => (await settled()).toBeGreaterThanOrEqual(n),
    toBeLessThan: async (n) => (await settled()).toBeLessThan(n),
    toBeLessThanOrEqual: async (n) => (await settled()).toBeLessThanOrEqual(n),
    toBeCloseTo: async (n, numDigits) => (await settled()).toBeCloseTo(n, numDigits),
    toContain: async (item) => (await settled()).toContain(item),
    toMatch: async (expected) => (await settled()).toMatch(expected),
    toHaveLength: async (length) => (await settled()).toHaveLength(length),
    toThrow: async (expected) => {
      const reason = await settle();
      if (expected === undefined) return;
      const pass = errorMatches(reason, expected);
      if (pass === negated) {
        const verb = negated ? "not to match" : "to match";
        throw new AssertionError(
          `expected rejection ${verb} ${describeThrow(expected)}, got ${fmt(reason)}`,
        );
      }
    },
    get not() {
      return makeAsync(subject, expectRejection, !negated);
    },
  };
}

function checkThrow(
  subject: string,
  threw: boolean,
  thrown: unknown,
  expected: ThrowMatcher | undefined,
  negated: boolean,
): void {
  const pass = threw && errorMatches(thrown, expected);
  if (pass !== negated) return;
  const what = expected !== undefined ? ` ${describeThrow(expected)}` : "";
  const verb = negated ? `not to throw${what}` : `to throw${what}`;
  const got = threw && expected !== undefined ? `, threw ${fmt(thrown)}` : "";
  throw new AssertionError(`expected ${subject} ${verb}${got}`);
}

function errorMatches(thrown: unknown, expected?: ThrowMatcher): boolean {
  if (expected === undefined) return true;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "function") return thrown instanceof expected;
  if (expected instanceof Error) return message === expected.message;
  return false;
}

function describeThrow(expected: ThrowMatcher): string {
  if (typeof expected === "string") return JSON.stringify(expected);
  if (expected instanceof RegExp) return String(expected);
  if (typeof expected === "function") return expected.name || "Error";
  if (expected instanceof Error) return JSON.stringify(expected.message);
  return String(expected);
}

function describeMatch(expected: string | RegExp): string {
  return expected instanceof RegExp ? String(expected) : fmt(expected);
}

function fmt(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function fmtDiff(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
