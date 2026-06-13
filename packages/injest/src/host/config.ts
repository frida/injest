import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Ajv } from "ajv";

export type Runtime = "qjs" | "v8";

export type SessionSpec = "system" | { spawn: string; args?: string[] };

export type DeviceSpec = "local" | "usb" | { id: string };

export interface TargetConfig {
  device: DeviceSpec;
  session: SessionSpec;
  runtime?: Runtime;
  timeout?: number;
}

export interface Config {
  default?: string;
  targets: Record<string, TargetConfig>;
  include?: string[];
  exclude?: string[];
}

const schema = JSON.parse(
  readFileSync(new URL("../../schema/injest.config.schema.json", import.meta.url), "utf8"),
);
const validate = new Ajv({ allErrors: true }).compile<Config>(schema);

export function validateConfig(value: unknown, file = "injest.config.json"): Config {
  if (validate(value)) return value;
  const issues = (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
  throw new Error(`invalid config in ${file}:\n  - ${issues.join("\n  - ")}`);
}

export function loadConfig(path = "injest.config.json"): Config {
  const file = resolve(process.cwd(), path);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`config not found: ${file}`);
  }
  return validateConfig(JSON.parse(raw), file);
}

export function resolveTarget(
  config: Config,
  name?: string,
): { name: string; target: TargetConfig } {
  const chosen = name ?? config.default;
  if (!chosen) {
    throw new Error('no --target given and no "default" in config');
  }
  const target = config.targets[chosen];
  if (!target) {
    const available = Object.keys(config.targets).join(", ");
    throw new Error(`unknown target "${chosen}". available: ${available}`);
  }
  return { name: chosen, target };
}
