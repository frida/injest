export async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" ") + "\n");
  };
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  return chunks.join("");
}
