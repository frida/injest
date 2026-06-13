import { readFileSync } from "node:fs";

import * as ts from "typescript";

export type Mode = "run" | "skip";
export type Launch = "shared" | "isolated" | "suspended";

export interface TestInfo {
  id: string;
  index: number;
  name: string;
  mode: Mode;
  launch: Launch;
  file?: string;
  line?: number;
}

const LAUNCH_BY_MEMBER: Record<string, Launch> = {
  isolated: "isolated",
  suspended: "suspended",
};

function classifyTestCallee(callee: ts.Expression): { mode: Mode; launch: Launch } | null {
  if (ts.isIdentifier(callee)) {
    return callee.text === "test" ? { mode: "run", launch: "shared" } : null;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "test"
  ) {
    if (callee.name.text === "skip") return { mode: "skip", launch: "shared" };
    const launch = LAUNCH_BY_MEMBER[callee.name.text];
    if (launch) return { mode: "run", launch };
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
