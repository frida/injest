/// <reference types="frida-gum" />
import { test, expect, describe, beforeEach, afterEach } from "injest/agent";

describe("throwing beforeEach", () => {
  beforeEach(() => {
    throw new Error("before boom");
  });
  test("fails before its body runs", () => {
    expect(1).toBe(2);
  });
});

describe("throwing afterEach", () => {
  afterEach(() => {
    throw new Error("after boom");
  });
  test("fails despite a passing body", () => {
    expect(1).toBe(1);
  });
});
