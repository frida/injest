import assert from "node:assert/strict";
import { test } from "node:test";

import { AssertionError, expect } from "../src/agent/expect.js";

test("toBe: passes on identity, fails otherwise with a diff", () => {
  expect(2).toBe(2);
  try {
    expect(1).toBe(2);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof AssertionError);
    assert.equal(e.operator, "toBe");
    assert.equal(e.expected, "2");
    assert.equal(e.actual, "1");
    assert.equal(e.showDiff, true);
  }
});

test("toEqual: deep-equals structurally", () => {
  expect({ a: [1, 2], b: "x" }).toEqual({ a: [1, 2], b: "x" });
  assert.throws(() => expect({ a: 1 }).toEqual({ a: 2 }), AssertionError);
});

test("toBeTruthy / toBeFalsy", () => {
  expect(1).toBeTruthy();
  expect(0).toBeFalsy();
  const err = assertThrows(() => expect(0).toBeTruthy());
  assert.equal(err.showDiff, false);
  assert.throws(() => expect("x").toBeFalsy(), AssertionError);
});

test("toBeNull / toBeUndefined / toBeDefined / toBeNaN", () => {
  expect(null).toBeNull();
  expect(undefined).toBeUndefined();
  expect(0).toBeDefined();
  expect(NaN).toBeNaN();
  assert.throws(() => expect(0).toBeNull(), AssertionError);
  assert.throws(() => expect(undefined).toBeDefined(), AssertionError);
  assert.throws(() => expect(1).toBeNaN(), AssertionError);
});

test("numeric comparisons", () => {
  expect(3).toBeGreaterThan(2);
  expect(3).toBeGreaterThanOrEqual(3);
  expect(1).toBeLessThan(2);
  expect(2).toBeLessThanOrEqual(2);
  expect(0.1 + 0.2).toBeCloseTo(0.3);
  assert.throws(() => expect(2).toBeGreaterThan(3), AssertionError);
  assert.throws(() => expect(0.3).toBeCloseTo(0.31), AssertionError);
});

test("numeric comparisons reject non-numbers (even under .not)", () => {
  assert.throws(() => expect("x" as unknown).toBeGreaterThan(1), /expected a number/);
  assert.throws(() => expect("x" as unknown).not.toBeGreaterThan(1), /expected a number/);
});

test("toContain: strings and arrays", () => {
  expect("hello world").toContain("world");
  expect([1, 2, 3]).toContain(2);
  assert.throws(() => expect("hello").toContain("xyz"), AssertionError);
  assert.throws(() => expect(42 as unknown).toContain(4), /expects a string or array/);
});

test("toMatch: regex and substring", () => {
  expect("abc123").toMatch(/\d+/);
  expect("abc123").toMatch("c12");
  assert.throws(() => expect("abc").toMatch(/\d+/), AssertionError);
  assert.throws(() => expect(123 as unknown).toMatch(/\d+/), /expects a string/);
});

test("toHaveLength", () => {
  expect([1, 2, 3]).toHaveLength(3);
  expect("abcd").toHaveLength(4);
  assert.throws(() => expect([1]).toHaveLength(2), AssertionError);
  assert.throws(() => expect(5 as unknown).toHaveLength(1), /numeric length/);
});

test("toThrow: passes when fn throws, fails when it doesn't", () => {
  expect(() => {
    throw new Error("boom");
  }).toThrow();
  assert.throws(() => expect(() => 1).toThrow(), /expected function to throw/);
});

test("toThrow: matches message substring, regex, and error class", () => {
  class CustomError extends Error {}
  expect(() => {
    throw new Error("boom: bad input");
  }).toThrow("bad input");
  expect(() => {
    throw new Error("boom: bad input");
  }).toThrow(/bad \w+/);
  expect(() => {
    throw new CustomError("nope");
  }).toThrow(CustomError);
  assert.throws(
    () =>
      expect(() => {
        throw new Error("boom");
      }).toThrow("different"),
    /expected function to throw/,
  );
});

test("toThrow: rejects a non-function actual", () => {
  assert.throws(() => expect(42 as unknown).toThrow(), /toThrow\(\) expects a function/);
});

test(".not negates matchers", () => {
  expect(1).not.toBe(2);
  expect({ a: 1 }).not.toEqual({ a: 2 });
  expect("hello").not.toContain("xyz");
  expect(() => 1).not.toThrow();
  assert.throws(() => expect(1).not.toBe(1), /expected 1 not to be 1/);
  assert.throws(
    () =>
      expect(() => {
        throw new Error("boom");
      }).not.toThrow(),
    /not to throw/,
  );
});

test(".not failures carry no diff", () => {
  const err = assertThrows(() => expect(1).not.toBe(1 as unknown));
  assert.equal(err.showDiff, false);
});

test("rejects: awaits a rejection and asserts on the reason", async () => {
  await expect(Promise.reject(new Error("boom"))).rejects.toThrow("boom");
  await expect(Promise.reject(new Error("boom"))).rejects.toThrow(/bo+m/);
  await expect(Promise.reject("plain")).rejects.toBe("plain");
  await assert.rejects(
    () => expect(Promise.resolve(1)).rejects.toThrow(),
    /expected promise to reject/,
  );
  await assert.rejects(
    () => expect(Promise.reject(new Error("boom"))).rejects.toThrow("different"),
    /expected rejection to match/,
  );
});

test("resolves: awaits a value and asserts on it", async () => {
  await expect(Promise.resolve(42)).resolves.toBe(42);
  await expect(Promise.resolve({ a: 1 })).resolves.toEqual({ a: 1 });
  await expect(Promise.resolve(5)).resolves.not.toBe(6);
  await assert.rejects(
    () => expect(Promise.reject(new Error("boom"))).resolves.toBe(1),
    /expected promise to resolve/,
  );
  await assert.rejects(() => expect(Promise.resolve(1)).resolves.toBe(2), AssertionError);
});

test("AssertionError: diff formatting pretty-prints objects", () => {
  const err = assertThrows(() => expect({ a: 1 }).toBe({ a: 2 } as unknown));
  assert.match(err.actual ?? "", /\{\n {2}"a": 1\n\}/);
});

function assertThrows(fn: () => void): AssertionError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AssertionError, "expected an AssertionError");
    return e;
  }
  throw new assert.AssertionError({ message: "expected fn to throw" });
}
