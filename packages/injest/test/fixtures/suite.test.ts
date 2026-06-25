/// <reference types="frida-gum" />
import { test, expect, describe } from "@frida/injest/agent";

test("passes", () => {
  expect(1 + 1).toBe(2);
});

test("fails", () => {
  expect(1).toBe(2);
});

test("async passes", async () => {
  expect(await Promise.resolve(7)).toBe(7);
});

test("throws as expected", () => {
  expect(() => {
    throw new Error("boom");
  }).toThrow();
});

test("ctx skip", ({ skip }) => {
  skip("nope");
});

test.skip("static skip", () => {
  expect(1).toBe(2);
});

test("runs inside GumJS", () => {
  expect(typeof Frida.version).toBe("string");
});

describe("Group", () => {
  test("nested passes", () => {
    expect("a").toBe("a");
  });
});
