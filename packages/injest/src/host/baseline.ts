import { readFileSync, writeFileSync } from "node:fs";

import type { BenchSamples, TestResult } from "./run.js";

export interface BenchBaseline {
  counters: Record<string, number>;
  wallUs: { min: number; median: number };
}

export interface BaselineEntry {
  machine: string;
  benches: Record<string, BenchBaseline>;
}

/** Keyed by `platform-arch-runtime`: counts are exact per platform, times only on one machine. */
export type BaselineFile = Record<string, BaselineEntry>;

export interface Environment {
  platform: string;
  arch: string;
}

export type BaselineVerdict = "ok" | "new" | "drifted" | "regressed";

// A minimum within this many ticks of its baseline is timer noise, whatever the ratio says: a
// baseline of 0µs would otherwise make every nonzero reading an infinite regression.
export const TIMER_FLOOR_TICKS = 10;

export interface BaselineComparison {
  verdict: BaselineVerdict;
  detail?: string;
}

export function baselineKey(env: Environment, runtime: string): string {
  return `${env.platform}-${env.arch}-${runtime}`;
}

export function loadBaseline(path: string, allowMissing: boolean): BaselineFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    if (allowMissing) return {};
    throw new Error(`baseline not found: ${path} (run with --update to create it)`);
  }
  return JSON.parse(raw) as BaselineFile;
}

export function saveBaseline(path: string, file: BaselineFile): void {
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

// A counter is pinned at its worst iteration, so one that varies is held to its maximum.
export function summarizeBench(b: BenchSamples): BenchBaseline {
  const sorted = [...b.wallUs].sort((x, y) => x - y);
  return {
    counters: Object.fromEntries(
      Object.entries(b.counters).map(([name, values]) => [name, Math.max(0, ...values)]),
    ),
    wallUs: { min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0 },
  };
}

export function compareBench(
  samples: BenchSamples,
  base: BenchBaseline | undefined,
  sameMachine: boolean,
  timeFactor: number,
): BaselineComparison {
  if (base === undefined) return { verdict: "new" };
  const current = summarizeBench(samples);
  const regressions: string[] = [];
  const drifts: string[] = [];
  for (const [name, value] of Object.entries(current.counters)) {
    const was = base.counters[name];
    if (was === undefined) drifts.push(`${name} not in baseline`);
    else if (value > was) regressions.push(`${name} ${value} > ${was}`);
    else if (value < was) drifts.push(`${name} ${value} < ${was}`);
  }
  const floorUs = TIMER_FLOOR_TICKS * samples.tickUs;
  if (
    sameMachine &&
    current.wallUs.min > timeFactor * base.wallUs.min &&
    current.wallUs.min - base.wallUs.min > floorUs
  ) {
    regressions.push(
      `min ${formatUs(current.wallUs.min)} > ${timeFactor}× ${formatUs(base.wallUs.min)}`,
    );
  }
  if (regressions.length > 0) return { verdict: "regressed", detail: regressions.join(", ") };
  if (drifts.length > 0) return { verdict: "drifted", detail: drifts.join(", ") };
  return { verdict: "ok" };
}

// The benches that ran replace their entries and the rest of the platform's entry is kept, so a
// filtered run updates only what it measured.
export function updateBaseline(
  file: BaselineFile,
  key: string,
  machine: string,
  results: TestResult[],
): BaselineFile {
  const benches = { ...file[key]?.benches };
  for (const r of results) {
    if (r.bench) benches[r.name] = summarizeBench(r.bench);
  }
  return { ...file, [key]: { machine, benches } };
}

export function formatUs(us: number): string {
  return us >= 1000 ? `${(us / 1000).toFixed(1)}ms` : `${Math.round(us)}µs`;
}
