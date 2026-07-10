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
