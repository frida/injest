import { readFileSync } from "node:fs";

import * as ts from "typescript";

export type Mode = "run" | "skip";
export type Launch = "shared" | "isolated" | "suspended";
export type Kind = "test" | "bench";

export interface TestInfo {
  id: string;
  index: number;
  name: string;
  mode: Mode;
  launch: Launch;
  kind: Kind;
  file?: string;
  line?: number;
}

const LAUNCH_BY_MEMBER: Record<string, Launch> = {
  isolated: "isolated",
  suspended: "suspended",
};

const KIND_BY_CALLEE = new Map<string, Kind>([
  ["test", "test"],
  ["bench", "bench"],
]);

type Classified = { mode: Mode; launch: Launch; kind: Kind };

function classifyTestCallee(callee: ts.Expression): Classified | null {
  if (ts.isIdentifier(callee)) {
    const kind = KIND_BY_CALLEE.get(callee.text);
    return kind ? { mode: "run", launch: "shared", kind } : null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const kind = KIND_BY_CALLEE.get(callee.expression.text);
    if (!kind) return null;
    if (callee.name.text === "skip" && kind === "test")
      return { mode: "skip", launch: "shared", kind };
    const launch = LAUNCH_BY_MEMBER[callee.name.text];
    // a bench has no suspended form: nothing to resume once the measured body is running
    if (launch && (kind === "test" || launch === "isolated")) return { mode: "run", launch, kind };
  }
  return null;
}

function isDescribeCallee(callee: ts.Expression): boolean {
  return ts.isIdentifier(callee) && callee.text === "describe";
}

type DiscoveredTest = Omit<TestInfo, "id" | "index">;

function testsInFile(absoluteFile: string): DiscoveredTest[] {
  let text: string;
  try {
    text = readFileSync(absoluteFile, "utf8");
  } catch {
    return [];
  }
  const sourceFile = ts.createSourceFile(absoluteFile, text, ts.ScriptTarget.Latest, true);
  const out: DiscoveredTest[] = [];
  // mirrors the agent's suiteStack (runtime.ts) so discovered names match registered ones
  const suiteStack: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const label = first && ts.isStringLiteralLike(first) ? first.text : undefined;

      if (label !== undefined && isDescribeCallee(node.expression)) {
        suiteStack.push(label);
        ts.forEachChild(node, visit);
        suiteStack.pop();
        return;
      }

      const kind = label !== undefined ? classifyTestCallee(node.expression) : null;
      if (label !== undefined && kind) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        out.push({ name: [...suiteStack, label].join(" › "), file: absoluteFile, line, ...kind });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

export function discoverTestInfo(files: string[]): TestInfo[] {
  const discovered = files.flatMap(testsInFile);

  const totals = new Map<string, number>();
  for (const t of discovered) totals.set(t.name, (totals.get(t.name) ?? 0) + 1);

  const seen = new Map<string, number>();
  return discovered.map((t, index) => {
    const occurrence = (seen.get(t.name) ?? 0) + 1;
    seen.set(t.name, occurrence);
    const id = (totals.get(t.name) ?? 0) > 1 ? `${t.name}#${occurrence}` : t.name;
    return { id, index, ...t };
  });
}

// regex, else substring fallback — must stay in sync with the agent's makeMatcher (runtime.ts)
export function matchTestName(grep: string | undefined): (name: string) => boolean {
  if (!grep) return () => true;
  try {
    const re = new RegExp(grep);
    return (name) => re.test(name);
  } catch {
    return (name) => name.includes(grep);
  }
}
