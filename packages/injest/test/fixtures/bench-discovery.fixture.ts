// Fixture parsed by source.spec.ts via discoverTestInfo(). Line numbers are
// asserted there, so keep additions at the bottom and don't reflow this file.
import { bench, describe } from "@frida/injest/agent";

bench("warm", ({ measure }) => measure(() => {}));
bench.isolated("cold", ({ measure }) => measure(() => {}));
describe("Group", () => {
  bench("nested", ({ measure }) => measure(() => {}));
});
