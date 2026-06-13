# injest for VS Code

Runs [`injest`](../injest/README.md) suites from the VS Code **Test Explorer**: tests appear
in the Testing sidebar with gutter run icons, results and `console.*` output stream in
live, and failures show a clickable stack trace — plus an expected/actual diff for
assertion failures — anchored to the throwing line.

It is a thin wrapper over the CLI — all the work happens in `injest`. The extension
only translates between the CLI's JSON contract and VS Code's `TestController` API:

- **Discovery** → `injest --list --reporter json` (`{"type":"list","tests":[…]}`).
- **Run** → `injest <file> --only <id>… --reporter json`, consuming the
  per-test NDJSON (`{"type":"test",…}` / `{"type":"output",…}`) as it streams.

## Develop / try it

```sh
npm install
npm run build
```

Then press **F5** (Run Extension) — this opens an Extension Development Host with the
parent `injest` project as the workspace. Open the **Testing** sidebar to see the
suite. Requires a working Frida target reachable from the configured profile.

## How runs map to the CLI

- Run a **subset of a file** → the file is filtered positionally and the selected tests
  are passed by stable id as repeated `--only <id>` flags.
- Run a **whole file** (all runnable tests) → the file is filtered, no `--only`.
- Run **all** → no filters.
- `test.skip` tests are reported skipped without invoking the runner. One CLI invocation
  per file (so each file gets its own Frida session, matching the runner's model).

## Settings

| Setting             | Default            | Maps to      |
| ------------------- | ------------------ | ------------ |
| `injest.command`    | `["npx","injest"]` | the CLI argv |
| `injest.target`     | _(empty)_          | `--target`   |
| `injest.configPath` | _(empty)_          | `--config`   |

The GumJS runtime and per-test timeout are set per target in `injest.config.json`
(`runtime`, default `qjs`; `timeout`, default `10000` ms), not from the extension.

The extension activates for any workspace folder containing `injest.config.json`.

## Commands

| Command                 | Does                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `injest: Refresh Tests` | Re-discover tests across all injest folders.                     |
| `injest: Show Output`   | Focus the injest Output channel.                                 |
| `injest: Open Config`   | Open `injest.config.json` (prompts when several exist).          |
| `injest: Select Target` | Pick a target from the config and persist it to `injest.target`. |

The non-default test attributes surface in the tree: `test.skip`, `test.isolated`, and
`test.suspended` show a badge (e.g. `skip`, `isolated`) and a matching filterable **test tag**.

## Known limitations / bugs

- **Renaming a test resets its run history** — a test's stable id is its qualified name
  (`describe › test`), so VS Code treats a rename as a new test. This is the deliberate
  tradeoff for ids that survive reordering; only renames lose history. (Duplicate names in
  one file are now handled: the runner's AST scan and the agent both assign a source-order
  occurrence suffix — `crypto › works#1`, `#2` — so same-named siblings bind to their own
  results and run individually. Reordering two identical-named siblings swaps their `#n`,
  the one case position can't disambiguate.)
- **No debug profile** — only Run. Debugging GumJS agents isn't wired up.
- **Windows** — `injest.command` is spawned without a shell, so the default `npx` needs
  to be reachable as an executable (fine on macOS/Linux; on Windows use an absolute path).
