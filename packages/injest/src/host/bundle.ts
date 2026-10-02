import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";

import * as frida from "frida";

export const DEFAULT_INCLUDE = ["tests/**/*.test.{ts,js}"];

export interface DiscoverOptions {
  include: string[];
  exclude?: string[];
  cwd?: string;
}

export function discoverTests(opts: DiscoverOptions): string[] {
  const root = resolve(opts.cwd ?? process.cwd());
  const included = opts.include.map(globToRegExp);
  const excluded = (opts.exclude ?? []).map(globToRegExp);

  const isExcluded = (relativePath: string): boolean =>
    excluded.some((re) => re.test(relativePath));
  const isExcludedDir = (relativePath: string): boolean =>
    isExcluded(relativePath) || isExcluded(relativePath + "/");

  const matched: string[] = [];
  const walkDir = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const fullPath = join(dir, name);
      const relativePath = relative(root, fullPath).split(sep).join("/");
      // lstatSync, not statSync: don't follow symlinks (dangling links throw, cycles recurse).
      if (lstatSync(fullPath).isDirectory()) {
        if (!isExcludedDir(relativePath)) walkDir(fullPath);
        continue;
      }
      const isTestFile = included.some((re) => re.test(relativePath)) && !isExcluded(relativePath);
      if (isTestFile) matched.push(fullPath);
    }
  };
  walkDir(root);
  return matched.sort();
}

const NESTED_DIRS = "(?:[^/]+/)*";
const ACROSS_SEGMENTS = ".*";
const WITHIN_SEGMENT = "[^/]*";
const ONE_NON_SLASH = "[^/]";
const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|\{[^}]*\}|[^*?{]+|\{/g;

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const source = normalized.replace(GLOB_TOKEN, (token) => {
    switch (token) {
      case "**/":
        return NESTED_DIRS;
      case "**":
        return ACROSS_SEGMENTS;
      case "*":
        return WITHIN_SEGMENT;
      case "?":
        return ONE_NON_SLASH;
    }
    if (token.length > 1 && token.startsWith("{") && token.endsWith("}")) {
      const alternatives = token.slice(1, -1).split(",").map(escapeRegExp);
      return `(?:${alternatives.join("|")})`;
    }
    return escapeRegExp(token);
  });
  return new RegExp(`^${source}$`);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CompileOptions {
  cwd?: string;
}

export async function compileTests(
  testFiles: string[],
  opts: CompileOptions = {},
): Promise<string> {
  const projectRoot = resolve(opts.cwd ?? process.cwd());
  const buildDir = join(projectRoot, `.injest-${process.pid}-${Date.now()}`);
  mkdirSync(buildDir, { recursive: true });
  const entry = join(buildDir, "entry.ts");
  writeFileSync(entry, entrySource(testFiles, buildDir));
  writeFileSync(join(buildDir, "tsconfig.json"), tsconfigSource(projectRoot));

  const compiler = new frida.Compiler();
  compiler.diagnostics.connect((diagnostics) => {
    for (const d of diagnostics) {
      const where = d.file ? ` ${d.file.path}:${d.file.line}:${d.file.character}` : "";
      console.error(`[injest] ${d.category}${where}: ${d.text}`);
    }
  });

  try {
    return await compiler.build(entry, {
      projectRoot: buildDir,
      sourceMaps: frida.SourceMaps.Included,
    });
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

// The compiler applies <projectRoot>/tsconfig.json as written, so the build dir carries its own:
// the project's settings minus two a library build tends to set that break here. rootDir would
// have to contain the entry file and every test (TypeScript 7 no longer infers it), and sourceMap
// collides with the inline map requested above.
function tsconfigSource(projectRoot: string): string {
  const projectConfig = join(projectRoot, "tsconfig.json");
  return JSON.stringify({
    ...(existsSync(projectConfig) ? { extends: projectConfig } : {}),
    compilerOptions: { rootDir: parse(projectRoot).root, sourceMap: false },
  });
}

function entrySource(testFiles: string[], entryDir: string): string {
  const imports = testFiles.map((f) => {
    let rel = relative(entryDir, f).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return `import ${JSON.stringify(rel)};`;
  });
  return [
    '/// <reference types="frida-gum" />',
    'import { run } from "@frida/injest/agent";',
    ...imports,
    "rpc.exports = { run };",
    "",
  ].join("\n");
}
