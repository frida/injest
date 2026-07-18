import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { test } from "node:test";

import { resolveLocalSpawn } from "../src/host/session.js";

const root = "/projects/demo";

test("resolveLocalSpawn: resolves a relative path against the project root", () => {
  assert.equal(resolveLocalSpawn("./build/test", root), resolve(root, "build/test"));
  assert.equal(resolveLocalSpawn("build/test", root), resolve(root, "build/test"));
  assert.equal(resolveLocalSpawn("../sibling/test", root), resolve(root, "../sibling/test"));
});

test("resolveLocalSpawn: leaves an absolute path unchanged", () => {
  assert.equal(resolveLocalSpawn("/usr/bin/test", root), "/usr/bin/test");
});

test("resolveLocalSpawn: leaves bundle ids and bare program names unchanged", () => {
  assert.equal(resolveLocalSpawn("com.apple.MobileSafari", root), "com.apple.MobileSafari");
  assert.equal(resolveLocalSpawn("cat", root), "cat");
});

test("resolveLocalSpawn: always returns an absolute path for path-like input", () => {
  assert.ok(isAbsolute(resolveLocalSpawn("./build/test", root)));
});
