/// <reference types="frida-gum" />
import { test, expect, describe, beforeEach, afterEach } from "@frida/injest/agent";

const hookLog: string[] = [];

beforeEach(() => {
  hookLog.push("outerBefore");
});
afterEach(() => {
  hookLog.push("outerAfter");
});

test("root test sees only the outer beforeEach", () => {
  expect(hookLog).toEqual(["outerBefore"]);
});

describe("nested", () => {
  beforeEach(() => {
    hookLog.push("innerBefore");
  });
  afterEach(() => {
    hookLog.push("innerAfter");
  });

  test("nested test sees outer then inner beforeEach", () => {
    expect(hookLog).toEqual(["outerBefore", "outerAfter", "outerBefore", "innerBefore"]);
  });
});

test("afterEach unwinds inner before outer", () => {
  expect(hookLog).toEqual([
    "outerBefore",
    "outerAfter",
    "outerBefore",
    "innerBefore",
    "innerAfter",
    "outerAfter",
    "outerBefore",
  ]);
});
