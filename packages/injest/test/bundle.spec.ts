import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";

import { DEFAULT_INCLUDE, discoverTests } from "../src/host/bundle.js";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "injest-discover-"));
  for (const rel of [
    "tests/a.test.ts",
    "tests/sub/b.test.ts",
    "tests/c.test.js",
    "tests/d.spec.ts",
    "src/e.test.ts",
    "node_modules/pkg/f.test.ts",
    ".hidden/g.test.ts",
  ]) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "");
  }
});

after(() => rmSync(root, { recursive: true, force: true }));

const found = (include: string[], exclude?: string[]): string[] =>
  discoverTests({ include, exclude, cwd: root })
    .map((p) => relative(root, p).split(sep).join("/"))
    .sort();

test("DEFAULT_INCLUDE: tests/ tree only, both extensions, skips wrong suffix & pruned dirs", () => {
  assert.deepEqual(found(DEFAULT_INCLUDE), [
    "tests/a.test.ts",
    "tests/c.test.js",
    "tests/sub/b.test.ts",
  ]);
});

test("** spans segments and reaches outside tests/", () => {
  assert.deepEqual(found(["**/*.test.ts"]), [
    "src/e.test.ts",
    "tests/a.test.ts",
    "tests/sub/b.test.ts",
  ]);
});

test("single * stays within one segment", () => {
  assert.deepEqual(found(["tests/*.test.{ts,js}"]), ["tests/a.test.ts", "tests/c.test.js"]);
});

test("a leading ./ in a glob is normalized away", () => {
  assert.deepEqual(found(["./**/*.test.ts"]), found(["**/*.test.ts"]));
});

test("exclude removes matches from include", () => {
  assert.deepEqual(found(DEFAULT_INCLUDE, ["tests/sub/**"]), [
    "tests/a.test.ts",
    "tests/c.test.js",
  ]);
});

test("node_modules and dot directories are always pruned", () => {
  assert.deepEqual(
    found(["**/*.test.ts"]).filter((p) => p.includes("node_modules")),
    [],
  );
  assert.deepEqual(
    found(["**/*.test.ts"]).filter((p) => p.includes(".hidden")),
    [],
  );
});

test("a dangling symlink does not crash discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "injest-symlink-"));
  try {
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests/a.test.ts"), "");
    mkdirSync(join(dir, "resources"), { recursive: true });
    symlinkSync(join(dir, "resources/missing-target"), join(dir, "resources/dangling-link"));
    const result = discoverTests({ include: DEFAULT_INCLUDE, cwd: dir }).map((p) =>
      relative(dir, p).split(sep).join("/"),
    );
    assert.deepEqual(result, ["tests/a.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare directory name in exclude prunes the directory, not just files named it", () => {
  const dir = mkdtempSync(join(tmpdir(), "injest-prune-"));
  try {
    writeFileSync(join(dir, "keep.test.ts"), "");
    mkdirSync(join(dir, "excluded-dir"), { recursive: true });
    writeFileSync(join(dir, "excluded-dir/nested.test.ts"), "");
    const result = discoverTests({ include: ["**/*.test.ts"], exclude: ["excluded-dir"], cwd: dir })
      .map((p) => relative(dir, p).split(sep).join("/"))
      .sort();
    assert.deepEqual(result, ["keep.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
