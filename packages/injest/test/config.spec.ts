import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig, resolveTarget, validateConfig, type Config } from "../src/host/config.js";

function withConfigFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "injest-cfg-"));
  const path = join(dir, "injest.config.json");
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadConfig: reads a valid config", () => {
  withConfigFile(
    JSON.stringify({
      default: "local",
      targets: { local: { device: "local", session: "system" } },
    }),
    (path) => {
      const cfg = loadConfig(path);
      assert.equal(cfg.default, "local");
      assert.deepEqual(cfg.targets.local, { device: "local", session: "system" });
    },
  );
});

test("loadConfig: throws when the file is missing", () => {
  assert.throws(() => loadConfig("/no/such/injest.config.json"), /config not found/);
});

test("loadConfig: throws when there are no targets", () => {
  withConfigFile(JSON.stringify({ targets: {} }), (path) => {
    assert.throws(() => loadConfig(path), /invalid config.*fewer than 1 properties/s);
  });
});

test("loadConfig: throws when targets is missing entirely", () => {
  withConfigFile(JSON.stringify({ default: "local" }), (path) => {
    assert.throws(() => loadConfig(path), /invalid config.*must have required property 'targets'/s);
  });
});

test("validateConfig: rejects a bad device with a field path", () => {
  assert.throws(
    () => validateConfig({ targets: { local: { device: "wifi", session: "system" } } }),
    /\/targets\/local\/device/,
  );
});

test("validateConfig: rejects an unknown property", () => {
  assert.throws(
    () => validateConfig({ targets: { local: { device: "local", session: "system" } }, bogus: 1 }),
    /invalid config/,
  );
});

test("schema validates the shipped example config", () => {
  const schemaPath = fileURLToPath(new URL("../schema/injest.config.schema.json", import.meta.url));
  const examplePath = fileURLToPath(new URL("../examples/injest.config.json", import.meta.url));
  JSON.parse(readFileSync(schemaPath, "utf8"));
  const example = JSON.parse(readFileSync(examplePath, "utf8"));
  assert.deepEqual(validateConfig(example), example);
});

const cfg: Config = {
  default: "local",
  targets: {
    local: { device: "local", session: "system" },
    phone: { device: "usb", session: { spawn: "com.example" } },
  },
};

test("resolveTarget: explicit name wins", () => {
  const { name, target } = resolveTarget(cfg, "phone");
  assert.equal(name, "phone");
  assert.equal(target.device, "usb");
});

test("resolveTarget: falls back to default", () => {
  const { name } = resolveTarget(cfg, undefined);
  assert.equal(name, "local");
});

test("resolveTarget: unknown name lists available targets", () => {
  assert.throws(() => resolveTarget(cfg, "nope"), /unknown target "nope".*local, phone/s);
});

test("resolveTarget: no name and no default throws", () => {
  const noDefault: Config = { targets: cfg.targets };
  assert.throws(() => resolveTarget(noDefault, undefined), /no --target given/);
});
