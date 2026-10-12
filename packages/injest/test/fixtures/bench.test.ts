/// <reference types="frida-gum" />
import { bench, counter } from "@frida/injest/agent";

const work = {
  calls: 0,
  step(): void {
    this.calls++;
  },
};
counter("steps", work, "step");

bench(
  "counts steps and samples time",
  ({ measure }) => {
    measure(() => {
      work.step();
      work.step();
    });
  },
  { warmup: 1, iterations: 3 },
);

bench(
  "awaits an async body",
  async ({ measure }) => {
    await measure(async () => {
      await Promise.resolve();
      work.step();
    });
  },
  { warmup: 0, iterations: 2 },
);

bench(
  "fails when the body throws",
  ({ measure }) => {
    measure(() => {
      throw new Error("boom");
    });
  },
  { iterations: 1 },
);

bench("fails without a measurement", () => {});
