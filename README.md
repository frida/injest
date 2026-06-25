# injest

A test runner for code that runs inside Frida's **GumJS** runtime, plus a VS Code
integration.

> Status: pre-1.0; APIs and output may change.

## Packages

This is an npm-workspaces monorepo. Each package has its own README:

| Package                                                            | What it is                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [`packages/injest`](packages/injest/README.md)                     | The test runner: CLI + agent test API (`@frida/injest/agent`). **Start here.**          |
| [`packages/vscode-extension`](packages/vscode-extension/README.md) | Thin VS Code wrapper — runs suites from the Test Explorer via the runner's JSON output. |

## Development

```sh
npm install                 # installs all workspaces (single root lockfile)
npm run build               # builds every workspace
npm run build -w injest     # build just the runner
```

The repo is a private workspace root (`packages/*`) with a shared `tsconfig.base.json`;
each package extends it. The extension depends on the local `@frida/injest` so it runs
against your in-tree build.
