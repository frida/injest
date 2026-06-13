# injest

The test runner for code that runs inside Frida's **GumJS** runtime — CLI + agent test API.
Point it at a target (device + session) in JSON; it bundles your tests with the code under
test, injects them, runs the suite in GumJS, and reports to the terminal or as NDJSON.
Subject- and target-agnostic: anything that runs in GumJS works.

## Quick start

In the project under test, add `injest` and a config:

```jsonc
// package.json
{ "type": "module", "devDependencies": { "injest": "^0.1.0" } }
```

```jsonc
// injest.config.json
{ "default": "local", "targets": { "local": { "device": "local", "session": "system" } } }
```

```ts
// tests/example.test.ts
import { test, expect } from "injest/agent";

test("platform must be linux", () => {
  expect(Process.platform).toBe("linux");
});
```

```sh
npx injest --target local
```

> Test files are discovered from `tests/**/*.test.{ts,js}` by default — set `include`/`exclude`
> in the config to put them elsewhere (e.g. colocated `src/**/*.test.ts`). The runner writes a
> temporary `.injest-*` build dir in the project; add `.injest-*` to your `.gitignore`.

## Targets

A target is a **device** + **session**, with an optional **runtime**:

```jsonc
{
  "default": "local",
  "targets": {
    "local": { "device": "local", "session": "system" },
    "local-v8": { "device": "local", "session": "system", "runtime": "v8" },
    "usb": { "device": "usb", "session": "system" },
    "phone": { "device": { "id": "<udid>" }, "session": "system" },
    "app": { "device": { "id": "<udid>" }, "session": { "spawn": "<bundle-id>" } },
  },
  // optional — where test files live (defaults to ["tests/**/*.test.{ts,js}"])
  "include": ["tests/**/*.test.ts"],
  "exclude": ["tests/wip/**"],
}
```

- `device`: `"local"`, `"usb"` (first USB device), or `{ "id": "<udid>" }` (a specific
  device).
- `session`: `"system"` or `{ "spawn": "<program-or-bundle-id>", "args": [...] }`.
- `runtime`: `qjs` (default) or `v8`.
- `timeout`: default per-test timeout in ms (default `10000`); a test can override it with
  `test(name, fn, { timeout })`.

## Test discovery

Test files are matched by the `include` globs in the config (default
`["tests/**/*.test.{ts,js}"]`), minus any `exclude` globs. Globs are matched against
project-relative paths and support `**`, `*`, `?`, and `{a,b}` alternation;
`node_modules` and dot-directories are always skipped. Positional CLI args narrow the
matched files further by path substring.

## Selecting tests

```sh
npx injest foo            # files whose path contains "foo"
npx injest -t "digest"    # tests whose name matches the regex
```

The GumJS runtime is a property of the target (`runtime`, default `qjs`); to run
the suite on both, define one target per runtime.

```ts
test.skip("park", () => {});
```

## Launch modes

Tests share one session by default. A test can opt into its own fresh process — required
for tests that mutate global/native state or need launch-time control. Both forms need a
`spawn` target; on a non-spawnable target (e.g. `system`) they're reported skipped.

```ts
// own fresh spawn, killed afterwards — isolation is by process, not cleanup
test.isolated("runs in a clean process", () => {
  expect(Process.mainModule.name.length > 0).toBeTruthy();
});

// spawn starts suspended: instrument before the app runs, then resume() it.
// `resume` is injected — it exists only in this launch mode.
test.suspended("hooks before main runs", async ({ resume }) => {
  const open = Module.getGlobalExportByName("open");
  const fired = new Promise<void>((done) => {
    Interceptor.attach(open, { onEnter: () => done() });
  });
  await resume();
  await fired;
});
```

A test can also bail out at runtime via the injected `skip`, reporting itself skipped
(not a false pass) with an optional reason:

```ts
test("apple-silicon only", ({ skip }) => {
  if (Process.arch !== "arm64") skip(`needs arm64, got ${Process.arch}`);
  expect(Process.pointerSize).toBe(8);
});
```

## CLI

```
injest [file-filters...] [options]

  --target <name>             target profile (else "default")
  -c, --config <path>         config file (default: ./injest.config.json)
  -t, --testNamePattern <re>  run only tests whose name matches
  --only <id>                 run only the test(s) with this stable id (repeatable)
  --reporter <pretty|json>    output format (json = NDJSON on stdout)
  --list                      list tests (id, location) without running
  -h, --help                  show help
```

## Test API (`injest/agent`)

- `test(name, fn, opts?)` — register a test; may be `async`. `opts.launch` is
  `"shared"` (default) | `"isolated"` | `"suspended"`; `opts.timeout` (ms) overrides the
  target's default timeout for this test.
- `test.skip` — statically skip a test.
- `test.isolated(name, fn, opts?)` — run in a fresh spawn, killed afterwards.
- `test.suspended(name, async ({ resume }) => …, opts?)` — run in a spawn started suspended;
  call the injected `resume()` to release the main thread.
- `describe(label, fn)` — group tests; names are qualified (`label › test`) and groups nest.
- `beforeEach(fn)` / `afterEach(fn)` — run around each test in the enclosing `describe`
  (and any nested one). `beforeEach` runs outermost→innermost; `afterEach` unwinds
  innermost→outermost and always runs (for cleanup) even when the test fails. A throwing
  hook fails the test; a `beforeEach` failure skips the body, an `afterEach` failure fails
  an otherwise-passing test.
- Every `fn` receives a context: `({ skip })` for normal tests, `({ skip, resume })` for
  `suspended`. `skip(reason?)` reports the test as skipped at runtime. Hooks receive no
  context.
- `expect(value)` matchers:
  - equality / truthiness: `toBe`, `toEqual` (structural deep equality), `toBeTruthy`,
    `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toBeDefined`, `toBeNaN`.
  - numbers: `toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`,
    `toBeLessThanOrEqual`, `toBeCloseTo(n, numDigits = 2)`.
  - strings / collections: `toContain` (string substring or array member), `toMatch`
    (regex or substring), `toHaveLength`.
  - `toThrow(expected?)` — `expected` may be a message substring, a `RegExp` matched
    against the message, or an error class (`instanceof`).
  - `.not` negates any matcher; `.rejects` / `.resolves` await a promise and apply the
    matcher to the rejection reason / resolved value (e.g.
    `await expect(p).rejects.toThrow("boom")`).
  - `toBe`/`toEqual` failures carry `expected`/`actual` for editor diffs.

## JSON output

`--reporter json` emits one object per line on stdout (diagnostics on stderr):

```
{"type":"start","total":2}
{"type":"output","level":"info","text":"hello","name":"…","file":"tests/x.test.ts","line":10}
{"type":"test","name":"…","status":"passed","durationMs":0,"file":"tests/x.test.ts","line":10}
{"type":"test","name":"boom","status":"failed","durationMs":1,"file":"tests/x.test.ts","line":12,"error":{"name":"AssertionError","message":"…","expected":"…","actual":"…"}}
{"type":"end","passed":1,"failed":1,"skipped":0,"total":2}
```

`status`: `passed | failed | skipped | timeout | crashed | incomplete`. `console.*` from a
test is streamed live as `{"type":"output",…}` between that test's events (with `name`/`file`
absent for output emitted outside any test). `--list --reporter json` emits
`{"type":"list","tests":[…]}`. Exit code is non-zero on any failure/timeout/crash/incomplete;
`skipped` never fails the run.
