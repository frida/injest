# injest

The test runner for code that runs inside Frida's **GumJS** runtime — CLI + agent test API.
Point it at a target (device + session) in JSON; it bundles your tests with the code under
test, injects them, runs the suite in GumJS, and reports to the terminal or as NDJSON.
Subject- and target-agnostic: anything that runs in GumJS works.

## Quick start

In the project under test, add `injest` and a config:

```jsonc
// package.json
{ "type": "module", "devDependencies": { "@frida/injest": "^0.1.0" } }
```

```jsonc
// injest.config.json
{ "default": "local", "targets": { "local": { "device": "local", "session": "system" } } }
```

```ts
// tests/example.test.ts
import { test, expect } from "@frida/injest/agent";

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
  --bench                     run the bench files instead of the test files
  --baseline <path>           compare each bench with this file; a counter above it fails
  --update                    with --baseline: write this platform's entry from the run
  --time-factor <n>           also fail on min time > n× baseline, same machine only (default 3)
  -h, --help                  show help
```

## Test API (`@frida/injest/agent`)

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

## Benchmarks

A bench is a test whose body is sampled: `injest --bench` runs the files matched by the
config's `bench` globs (default `["bench/**/*.bench.{ts,js}"]`) and reports, per bench, the
wall-clock and user time of every iteration and the number of calls each registered counter
saw. Selection, `describe`, hooks and launch modes work as for tests.

```ts
import { bench, counter } from "@frida/injest/agent";

counter("symbolTables", Module.prototype, "enumerateSymbols"); // calls to a JS method
counter("lookups", Module.getGlobalExportByName("dlsym")); // calls to a native function

bench(
  "listing a type",
  ({ measure }) => {
    const type = lookUp("MyApp.Robot"); // setup: not sampled
    measure(() => type.methods()); // the sampled body; may return a promise
  },
  { warmup: 2, iterations: 10 },
);

bench.isolated("first listing in a fresh process", ({ measure }) => {
  measure(() => lookUp("MyApp.Robot").methods());
});
```

- `bench(name, fn, opts?)` — `fn` receives `({ skip, measure })` and calls `measure(body)`
  exactly once. `body` runs `opts.warmup` times unsampled (default 2), then `opts.iterations`
  times sampled (default 10). `opts.launch` and `opts.timeout` are as for `test`; `bench.isolated`
  spawns a fresh process, where the first iteration is the cold one.
- `counter(name, object, method)` wraps a JS method; `counter(name, nativePointer)` counts a
  native function through Frida's `CallCountSampler`. Each registered counter is sampled around
  every iteration. A count is exact, so it is the signal to gate on; time is for reading.
- Time comes from Frida's `WallClockSampler` and `UserTimeSampler` in microseconds, with a
  `Date.now()` fallback on a runtime without them (then `userUs` is absent).

A bench passes when `fn` and every iteration complete; it fails like a test otherwise. The
pretty reporter prints the minimum and median wall time, the iteration count and each counter
(a counter that varied between iterations shows its range, `82..83`); the JSON reporter emits a
`{"type":"bench",…}` record in place of the test record, with `iterations`, `wallUs`, `userUs`
and `counters` inline.

### Baselines

```sh
npx injest --bench --baseline bench/baseline.json --update   # record this platform's numbers
npx injest --bench --baseline bench/baseline.json            # fail on a regression
```

The file holds one entry per `platform-arch-runtime`, since what a body touches can differ per
platform, with the machine that produced it. Per bench it stores each counter at its worst
iteration and the min and median wall time. `--update` rewrites the entries of the benches that
ran and keeps the rest, so a filtered run refreshes only what it measured; the diff of the file
is the performance review.

Comparing:

- A counter **above** its baseline fails the bench with a `BaselineError`, by however little:
  a count that legitimately grows is a deliberate `--update` in the same change.
- A counter below its baseline, or one the baseline lacks, is reported as drift and passes.
- Wall time fails only when the minimum exceeds `--time-factor` × the baseline's minimum **and**
  the baseline was recorded on this machine; elsewhere time is shown, never judged.
- A bench the entry lacks is `[new]`; a platform the file lacks is reported once and compared
  not at all.

The JSON record carries the outcome as `baseline: { verdict, detail }`, with `verdict` one of
`ok | new | drifted | regressed`.

## JSON output

`--reporter json` emits one object per line on stdout (diagnostics on stderr):

```
{"type":"start","total":2}
{"type":"output","level":"info","text":"hello","name":"…","file":"tests/x.test.ts","line":10}
{"type":"test","name":"…","status":"passed","durationMs":0,"file":"tests/x.test.ts","line":10}
{"type":"test","name":"boom","status":"failed","durationMs":1,"file":"tests/x.test.ts","line":12,"error":{"name":"AssertionError","message":"…","expected":"…","actual":"…"}}
{"type":"bench","name":"listing a type","status":"passed","durationMs":3,"file":"bench/x.bench.ts","line":4,"iterations":3,"wallUs":[52,48,49],"userUs":[51,48,48],"counters":{"symbolTables":[1,1,1]}}
{"type":"end","passed":1,"failed":1,"skipped":0,"total":2}
```

`status`: `passed | failed | skipped | timeout | crashed | incomplete`. `console.*` from a
test is streamed live as `{"type":"output",…}` between that test's events (with `name`/`file`
absent for output emitted outside any test). `--list --reporter json` emits
`{"type":"list","tests":[…]}`. Exit code is non-zero on any failure/timeout/crash/incomplete;
`skipped` never fails the run.
