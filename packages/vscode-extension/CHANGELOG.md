# Changelog

All notable changes to the injest VS Code extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.1] - Unreleased

### Added

- Initial release: discover and run `injest` (GumJS) suites from the VS Code
  Test Explorer, with live results, streamed `console.*` output, clickable stack
  traces, and expected/actual diffs for assertion failures.
- `test.skip` / `test.isolated` / `test.suspended` surface as badges and filterable
  test tags in the tree.
- Commands: Refresh Tests, Show Output, Open Config, Select Target.
- Settings: `injest.command`, `injest.target`, `injest.configPath`.
