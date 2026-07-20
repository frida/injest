import { expect, test } from "@frida/injest/agent";

test("compares Int64 by value without losing precision", () => {
  expect(int64("9007199254740993")).toEqual(int64("9007199254740993"));
  expect(int64("9007199254740993")).not.toEqual(int64("9007199254740994"));
});

test("compares UInt64 by value without losing precision", () => {
  expect(uint64("9007199254740993")).toEqual(uint64("9007199254740993"));
  expect(uint64("9007199254740993")).not.toEqual(uint64("9007199254740994"));
});

test("compares NativePointer by value", () => {
  expect(ptr("0x1234")).toEqual(ptr("0x1234"));
  expect(ptr("0x1234")).not.toEqual(ptr("0x1235"));
});

test("does not equate different GumJS scalar types", () => {
  expect(int64(11)).not.toEqual(uint64(11));
  expect(int64(11)).not.toEqual(ptr(11));
  expect(uint64(11)).not.toEqual(ptr(11));
});

test("does not equate GumJS scalar values with primitives", () => {
  expect(int64(11)).not.toEqual(11);
  expect(uint64(11)).not.toEqual(11);
  expect(ptr(11)).not.toEqual(11);
});

test("compares nested GumJS scalar values", () => {
  expect({ values: [int64(11), uint64(12), ptr(13)] }).toEqual({
    values: [int64(11), uint64(12), ptr(13)],
  });
  expect({ values: [int64(11), uint64(12), ptr(13)] }).not.toEqual({
    values: [int64(11), uint64(12), ptr(14)],
  });
});
