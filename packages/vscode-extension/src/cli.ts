import { spawn } from "node:child_process";
import * as vscode from "vscode";

import { NdjsonParser } from "./parse.js";

export const ExitCode = {
  Passed: 0,
  TestFailure: 1,
  HarnessFailure: 2,
} as const;

/** A test as reported by `injest --list --reporter json`. */
export interface ListedTest {
  id: string;
  name: string;
  mode: "run" | "skip";
  launch: "shared" | "isolated" | "suspended";
  file?: string;
  line?: number;
}

/** A per-test result line from the run NDJSON stream. */
export interface TestEvent {
  id?: string;
  name: string;
  status: "passed" | "failed" | "timeout" | "crashed" | "skipped" | "incomplete";
  durationMs: number;
  file?: string;
  line?: number;
  error?: { name: string; message: string; stack?: string; expected?: string; actual?: string };
}

/** A line of console output from a test (or global, when name is absent). */
export interface OutputEvent {
  level: string;
  text: string;
  name?: string;
  file?: string;
  line?: number;
}

export interface CliConfig {
  command: string[];
  target: string;
  configPath: string;
}

export function readConfig(scope: vscode.Uri): CliConfig {
  const c = vscode.workspace.getConfiguration("injest", scope);
  return {
    command: c.get<string[]>("command", ["npx", "injest"]),
    target: c.get<string>("target", ""),
    configPath: c.get<string>("configPath", ""),
  };
}

function commonArgs(cfg: CliConfig): string[] {
  const args: string[] = [];
  if (cfg.target) args.push("--target", cfg.target);
  if (cfg.configPath) args.push("--config", cfg.configPath);
  return args;
}

interface SpawnResult {
  /** Each parsed JSON object from stdout, in order. */
  json: any[];
  stderr: string;
  code: number | null;
}

/**
 * Run the CLI, parsing stdout as line-delimited JSON. `onJson` fires per object as it
 * streams in (used to report results live). Honors cancellation by killing the child.
 */
function run(
  cfg: CliConfig,
  args: string[],
  cwd: string,
  token: vscode.CancellationToken | undefined,
  onJson: ((obj: any) => void) | undefined,
): Promise<SpawnResult> {
  const [program, ...base] = cfg.command;
  const child = spawn(program, [...base, ...args], { cwd, shell: false });

  const json: any[] = [];
  const parser = new NdjsonParser();
  let stderr = "";

  const emit = (objects: unknown[]): void => {
    for (const obj of objects) {
      json.push(obj);
      onJson?.(obj);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => emit(parser.push(d)));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });

  const cancel = token?.onCancellationRequested(() => child.kill());

  return new Promise<SpawnResult>((resolve, reject) => {
    child.on("error", (err) => {
      cancel?.dispose();
      reject(err);
    });
    child.on("close", (code) => {
      cancel?.dispose();
      emit(parser.flush());
      resolve({ json, stderr, code });
    });
  });
}

/** Discover tests via `--list --reporter json`. */
export async function listTests(cfg: CliConfig, cwd: string): Promise<ListedTest[]> {
  const args = [...commonArgs(cfg), "--list", "--reporter", "json"];
  const res = await run(cfg, args, cwd, undefined, undefined);
  const listMsg = res.json.find((o) => o?.type === "list");
  if (!listMsg) {
    throw new Error(
      `injest --list produced no list output (exit ${res.code}).\n${res.stderr.trim()}`,
    );
  }
  return listMsg.tests as ListedTest[];
}

export interface RunRequest {
  /** Project-relative file path substrings to filter by (positional args). */
  fileFilters: string[];
  /** Explicit stable ids to run, or undefined to run all in the files. */
  onlyIds?: string[];
}

/**
 * Run a subset and stream `{type:"test"}` / `{type:"output"}` events to the handlers.
 * Returns stderr/exit for surfacing harness-level failures (e.g. unreachable target).
 */
export async function runTests(
  cfg: CliConfig,
  cwd: string,
  req: RunRequest,
  token: vscode.CancellationToken,
  handlers: { onResult: (ev: TestEvent) => void; onOutput: (ev: OutputEvent) => void },
): Promise<{ stderr: string; code: number | null }> {
  const args = [...commonArgs(cfg), "--reporter", "json"];
  for (const id of req.onlyIds ?? []) args.push("--only", id);
  args.push(...req.fileFilters);
  const res = await run(cfg, args, cwd, token, (obj) => {
    if (obj?.type === "test") handlers.onResult(obj as TestEvent);
    else if (obj?.type === "output") handlers.onOutput(obj as OutputEvent);
  });
  return { stderr: res.stderr, code: res.code };
}
