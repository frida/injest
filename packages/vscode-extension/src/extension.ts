import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";

import {
  ExitCode,
  ListedTest,
  OutputEvent,
  TestEvent,
  listTests,
  readConfig,
  runTests,
} from "./cli.js";
import { fileId, parseFileId, parseStackFrames, stableId } from "./parse.js";

type Mode = ListedTest["mode"];
type Launch = ListedTest["launch"];

/** Per-test-item metadata we need at run time (rebuilt on every discovery). */
const testMode = new Map<string, Mode>();
const testRunnerId = new Map<string, string>();

const TAGS: Record<Exclude<Mode, "run"> | Exclude<Launch, "shared">, vscode.TestTag> = {
  skip: new vscode.TestTag("skip"),
  isolated: new vscode.TestTag("isolated"),
  suspended: new vscode.TestTag("suspended"),
};

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("injest");
  context.subscriptions.push(output);

  const ctrl = vscode.tests.createTestController("injest", "injest");
  context.subscriptions.push(ctrl);

  ctrl.resolveHandler = async (item) => {
    if (!item) await discoverAll(ctrl);
  };
  ctrl.refreshHandler = async () => {
    await discoverAll(ctrl);
  };

  ctrl.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    (req, token) => runHandler(ctrl, req, token),
    true,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("injest.refresh", () => discoverAll(ctrl)),
    vscode.commands.registerCommand("injest.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("injest.openConfig", () => openConfig()),
    vscode.commands.registerCommand("injest.selectTarget", () => selectTarget(ctrl)),
  );

  // debounced re-discovery on config/test changes (--list is static source discovery, so this is cheap)
  const watcher = vscode.workspace.createFileSystemWatcher("**/{injest.config.json,*.test.ts}");
  const reload = debounce(() => void discoverAll(ctrl), 300);
  const onChange = (uri: vscode.Uri): void => {
    if (/[/\\](node_modules|\.injest-[^/\\]+)[/\\]/.test(uri.fsPath)) return;
    reload();
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  void discoverAll(ctrl);
}

export function deactivate(): void {}

/** Workspace folders that contain a injest config (or an explicit configPath). */
function fridaFolders(): vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.filter((f) => fs.existsSync(configFilePath(f)));
}

function configFilePath(folder: vscode.WorkspaceFolder): string {
  const cfg = readConfig(folder.uri);
  return cfg.configPath
    ? path.resolve(folder.uri.fsPath, cfg.configPath)
    : path.join(folder.uri.fsPath, "injest.config.json");
}

/** Prompt for a frida folder when more than one is present; null if the user cancels. */
async function pickFridaFolder(placeHolder: string): Promise<vscode.WorkspaceFolder | null> {
  const folders = fridaFolders();
  if (folders.length === 0) {
    vscode.window.showInformationMessage("injest: no injest.config.json in this workspace.");
    return null;
  }
  if (folders.length === 1) return folders[0];
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, folder: f })),
    { placeHolder },
  );
  return pick?.folder ?? null;
}

async function openConfig(): Promise<void> {
  const folder = await pickFridaFolder("Open injest config for which folder?");
  if (!folder) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configFilePath(folder)));
  await vscode.window.showTextDocument(doc);
}

/** Target names (and the config's default) declared in a folder's injest config. */
function readTargets(folder: vscode.WorkspaceFolder): { names: string[]; default?: string } {
  try {
    const raw = fs.readFileSync(configFilePath(folder), "utf8");
    const cfg = JSON.parse(raw) as { default?: string; targets?: Record<string, unknown> };
    return { names: Object.keys(cfg.targets ?? {}), default: cfg.default };
  } catch (err) {
    output.appendLine(`[selectTarget] ${folder.name}: ${(err as Error).message}`);
    return { names: [] };
  }
}

/** Pick a target from the config and persist it to the injest.target setting. */
async function selectTarget(ctrl: vscode.TestController): Promise<void> {
  const folder = await pickFridaFolder("Set injest target for which folder?");
  if (!folder) return;

  const { names, default: configDefault } = readTargets(folder);
  if (names.length === 0) {
    vscode.window.showWarningMessage(`injest: no targets defined in ${folder.name}'s config.`);
    return;
  }

  const current = readConfig(folder.uri).target;
  const annotate = (name: string): string => {
    const tags = [name === configDefault && "default", name === current && "selected"].filter(
      Boolean,
    );
    return tags.length ? tags.join(", ") : "";
  };
  type Item = vscode.QuickPickItem & { value: string };
  const items: Item[] = [
    { label: "$(clear-all) Use config default", description: configDefault ?? "", value: "" },
    ...names.map((name): Item => ({ label: name, description: annotate(name), value: name })),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `injest target (currently ${current || "config default"})`,
  });
  if (!pick) return;

  await vscode.workspace
    .getConfiguration("injest", folder.uri)
    .update("target", pick.value, vscode.ConfigurationTarget.WorkspaceFolder);
  await discoverAll(ctrl);
}

// Serialize discovery so overlapping triggers can't interleave items.replace/add.
let discovering: Promise<void> = Promise.resolve();

function discoverAll(ctrl: vscode.TestController): Promise<void> {
  discovering = discovering.then(() => discoverNow(ctrl)).catch(() => {});
  return discovering;
}

async function discoverNow(ctrl: vscode.TestController): Promise<void> {
  const folders = fridaFolders();
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const cfg = readConfig(folder.uri);
    let tests: ListedTest[];
    try {
      tests = await listTests(cfg, folder.uri.fsPath);
    } catch (err) {
      output.appendLine(`[discover] ${folder.name}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(`injest: discovery failed in ${folder.name} (see Output)`);
      continue;
    }
    replaceFolder(ctrl, i, folder, tests);
  }
}

/** Replace just this folder's subtree (items are prefixed with the folder index). */
function replaceFolder(
  ctrl: vscode.TestController,
  folderIndex: number,
  folder: vscode.WorkspaceFolder,
  tests: ListedTest[],
): void {
  const prefix = `${folderIndex}:`;
  for (const existing of iter(ctrl.items)) {
    if (existing.id.startsWith(prefix)) ctrl.items.delete(existing.id);
  }
  for (const t of tests) {
    const key = stableId(folderIndex, t.file ?? "(unknown)", t.id);
    testMode.delete(key);
    testRunnerId.delete(key);
  }

  const fileNodes = new Map<string, vscode.TestItem>();
  for (const t of tests) {
    const rel = t.file ?? "(unknown)";
    let fileItem = fileNodes.get(rel);
    if (!fileItem) {
      const uri = vscode.Uri.file(path.resolve(folder.uri.fsPath, rel));
      fileItem = ctrl.createTestItem(fileId(folderIndex, rel), rel, uri);
      fileNodes.set(rel, fileItem);
      ctrl.items.add(fileItem);
    }
    const id = stableId(folderIndex, rel, t.id);
    const testItem = ctrl.createTestItem(id, t.name, fileItem.uri);
    if (typeof t.line === "number") {
      testItem.range = new vscode.Range(t.line - 1, 0, t.line - 1, 0);
    }
    const attrs: (keyof typeof TAGS)[] = [];
    if (t.mode !== "run") attrs.push(t.mode);
    if (t.launch !== "shared") attrs.push(t.launch);
    if (attrs.length) {
      testItem.description = attrs.join(" · ");
      testItem.tags = attrs.map((a) => TAGS[a]);
    }
    testMode.set(id, t.mode);
    testRunnerId.set(id, t.id);
    fileItem.children.add(testItem);
  }
}

function iter(coll: vscode.TestItemCollection): vscode.TestItem[] {
  const out: vscode.TestItem[] = [];
  coll.forEach((i) => out.push(i));
  return out;
}

/** Collect leaf test items implied by a run request (selection or "run all"). */
function collectLeaves(ctrl: vscode.TestController, req: vscode.TestRunRequest): vscode.TestItem[] {
  const leaves: vscode.TestItem[] = [];
  const excluded = new Set(req.exclude ?? []);
  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item)) return;
    if (item.children.size === 0) leaves.push(item);
    else item.children.forEach(visit);
  };
  for (const r of req.include ?? iter(ctrl.items)) visit(r);
  return leaves;
}

async function runHandler(
  ctrl: vscode.TestController,
  req: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const run = ctrl.createTestRun(req);
  const leaves = collectLeaves(ctrl, req);

  const byKey = new Map<string, vscode.TestItem>();
  const resolved = new Set<string>();
  // Group runnable leaves by owning file (one CLI invocation per file).
  const groups = new Map<vscode.TestItem, vscode.TestItem[]>();

  for (const leaf of leaves) {
    // Statically-skipped tests never reach the runner — report them and move on.
    if (testMode.get(leaf.id) === "skip") {
      run.skipped(leaf);
      continue;
    }
    run.enqueued(leaf);
    byKey.set(leaf.id, leaf);
    const parent = leaf.parent;
    if (!parent) continue;
    const arr = groups.get(parent) ?? [];
    arr.push(leaf);
    groups.set(parent, arr);
  }

  const folders = fridaFolders();

  for (const [fileItem, selected] of groups) {
    if (token.isCancellationRequested) break;
    const { folderIndex, rel } = parseFileId(fileItem.id);
    const folder = folders[folderIndex];
    if (!folder) continue;
    const cfg = readConfig(folder.uri);

    // all runnable siblings selected → run the file unfiltered; else select exactly them by stable id
    const runnable = iter(fileItem.children).filter((c) => testMode.get(c.id) !== "skip");
    const runWholeFile = selected.length === runnable.length;
    const onlyIds = runWholeFile
      ? undefined
      : selected.map((i) => testRunnerId.get(i.id)).filter((id): id is string => id !== undefined);

    for (const i of selected) run.started(i);

    let aborted = false;
    let abortMsg = "";
    try {
      const res = await runTests(cfg, folder.uri.fsPath, { fileFilters: [rel], onlyIds }, token, {
        onResult: (ev) => applyResult(run, byKey, resolved, folderIndex, folder.uri.fsPath, ev),
        onOutput: (ev) => applyOutput(run, byKey, folderIndex, ev),
      });
      if (res.code !== ExitCode.Passed && res.code !== ExitCode.TestFailure) {
        aborted = true;
        abortMsg = res.stderr.trim() || `injest exited ${res.code}`;
      }
    } catch (err) {
      aborted = true;
      abortMsg = (err as Error).message;
    }

    for (const i of selected) {
      if (resolved.has(i.id)) continue;
      if (aborted && !token.isCancellationRequested)
        run.errored(i, new vscode.TestMessage(abortMsg));
      else run.skipped(i);
    }
  }

  if (token.isCancellationRequested) {
    for (const item of byKey.values()) {
      if (!resolved.has(item.id)) run.skipped(item);
    }
  }

  run.end();
}

/** Streams a line of test output into the run, attributed to its TestItem when known. */
function applyOutput(
  run: vscode.TestRun,
  byKey: Map<string, vscode.TestItem>,
  folderIndex: number,
  ev: OutputEvent,
): void {
  const text = ev.text.replace(/\r?\n/g, "\r\n") + "\r\n"; // VS Code requires CRLF
  const item = ev.file ? byKey.get(stableId(folderIndex, ev.file, ev.name ?? "")) : undefined;
  const location =
    item?.uri && typeof ev.line === "number"
      ? new vscode.Location(item.uri, new vscode.Position(ev.line - 1, 0))
      : undefined;
  run.appendOutput(text, location, item);
}

/** Routes a streamed test event to its TestItem and records the outcome. */
function applyResult(
  run: vscode.TestRun,
  byKey: Map<string, vscode.TestItem>,
  resolved: Set<string>,
  folderIndex: number,
  baseDir: string,
  ev: TestEvent,
): void {
  if (!ev.file || !ev.id) return;
  const item = byKey.get(stableId(folderIndex, ev.file, ev.id));
  if (!item) return;
  resolved.add(item.id);

  switch (ev.status) {
    case "passed":
      run.passed(item, ev.durationMs);
      return;
    case "skipped":
      run.skipped(item);
      return;
    default: {
      const header = ev.error ? `${ev.error.name}: ${ev.error.message}` : `status: ${ev.status}`;
      const msg = new vscode.TestMessage(header);
      const frames = ev.error?.stack ? parseStack(ev.error.stack, baseDir) : [];
      if (frames.length) msg.stackTrace = frames;
      msg.location = failureLocation(frames, item, ev.line);
      if (ev.error?.expected !== undefined || ev.error?.actual !== undefined) {
        msg.expectedOutput = ev.error.expected;
        msg.actualOutput = ev.error.actual;
      }
      run.failed(item, msg, ev.durationMs);
    }
  }
}

/**
 * Where to anchor the inline failure message: the throw site, not the test's declaration.
 * Prefer the topmost stack frame inside the test's own file, then the topmost resolved
 * frame, falling back to the declaration line when there is no usable stack.
 */
function failureLocation(
  frames: vscode.TestMessageStackFrame[],
  item: vscode.TestItem,
  declarationLine: number | undefined,
): vscode.Location | undefined {
  const located = frames.filter((f) => f.uri && f.position);
  const inTestFile = located.find((f) => f.uri!.toString() === item.uri?.toString());
  const frame = inTestFile ?? located[0];
  if (frame) return new vscode.Location(frame.uri!, frame.position!);
  if (item.uri && typeof declarationLine === "number") {
    return new vscode.Location(item.uri, new vscode.Position(declarationLine - 1, 0));
  }
  return undefined;
}

function parseStack(stack: string, baseDir: string): vscode.TestMessageStackFrame[] {
  return parseStackFrames(stack, baseDir, fs.existsSync).map(
    (frame) =>
      new vscode.TestMessageStackFrame(
        frame.label,
        vscode.Uri.file(frame.file),
        new vscode.Position(frame.line - 1, frame.column - 1),
      ),
  );
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
