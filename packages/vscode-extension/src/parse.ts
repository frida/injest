import * as path from "node:path";

export const stableId = (folderIndex: number, relFile: string, runnerId: string): string =>
  `${folderIndex}:${relFile}::${runnerId}`;

export const fileId = (folderIndex: number, relFile: string): string => `${folderIndex}:${relFile}`;

export function parseFileId(id: string): { folderIndex: number; rel: string } {
  const firstColon = id.indexOf(":");
  return { folderIndex: Number(id.slice(0, firstColon)), rel: id.slice(firstColon + 1) };
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export class NdjsonParser {
  private pending = "";

  push(chunk: string): unknown[] {
    this.pending += chunk;
    const completed: unknown[] = [];
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      const parsed = line ? parseJsonLine(line) : undefined;
      if (parsed !== undefined) completed.push(parsed);
    }
    return completed;
  }

  flush(): unknown[] {
    const line = this.pending.trim();
    this.pending = "";
    const parsed = line ? parseJsonLine(line) : undefined;
    return parsed === undefined ? [] : [parsed];
  }
}

export const RUNNER_FRAME = /agent\/(runtime|expect)\.|[/\\]entry\.|\.injest/;

const FRAME_LINE = /^at\s+(.*?)\s*\((.*)\)\s*$/;
const FRAME_LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;

export interface StackFrame {
  label: string;
  file: string;
  line: number;
  column: number;
}

export function parseStackFrames(
  stack: string,
  baseDir: string,
  fileExists: (absolutePath: string) => boolean,
): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("at ") || RUNNER_FRAME.test(line)) continue;

    const frameMatch = FRAME_LINE.exec(line);
    if (!frameMatch) continue;
    const locationMatch = FRAME_LOCATION.exec(frameMatch[2]);
    if (!locationMatch) continue;

    const [, file, lineNumber, columnNumber] = locationMatch;
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
    if (!fileExists(absolutePath)) continue;

    frames.push({
      label: frameMatch[1].trim(),
      file: absolutePath,
      line: Number(lineNumber),
      column: columnNumber ? Number(columnNumber) : 1,
    });
  }
  return frames;
}
