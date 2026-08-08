import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// CDK stacks under `lib/**` are verified by synth **template assertions**
// (behavioural, not line-counted) — the house pattern (see dot-curia's
// vitest.config.ts). Line/branch coverage thresholds on declarative stack
// bodies are verification theatre: they reward restructuring construct code
// to please the counter, not behavior that matters. So this project carries
// no coverage config at all; the gate is "does the synth-template assertion
// suite pass".
//
// `test/` (the orphaned live-integration test) is deliberately NOT included
// here — it hits real deployed AWS resources and is not part of the offline
// unit/synth suite.
export default defineConfig({
  root: dirname,
  test: {
    environment: "node",
    globals: false,
    // A CDK synth of the full app is seconds of CPU, not milliseconds, and
    // vitest's 5s default is a wall-clock budget. On a shared CI runner where
    // this suite competes with itself for two cores, synth-backed tests have
    // been observed blowing that default while doing exactly the work they do
    // locally in well under it. These tests assert on the synthesized
    // template; how long the synth took is not the property under test, so the
    // timeout is set where a genuine hang lives rather than where a slow
    // runner does.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // `lib/**` = synth-template assertions on the declarative stacks.
    // `lambda/**` = real business-logic units (e.g. the aggregate-stats
    // stream worker), which DO warrant executed line coverage.
    include: [
      "lib/__tests__/**/*.test.ts",
      "lambda/**/__tests__/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "dist/**", "cdk.out/**"],
  },
});
