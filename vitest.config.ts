import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@claude-stats/core/paths": path.resolve(__dirname, "packages/core/src/paths.ts"),
      "@claude-stats/core/types": path.resolve(__dirname, "packages/core/src/types.ts"),
      "@claude-stats/core/pricing": path.resolve(__dirname, "packages/core/src/pricing.ts"),
      "@claude-stats/core/parser/session": path.resolve(__dirname, "packages/core/src/parser/session.ts"),
      "@claude-stats/core/parser/telemetry": path.resolve(__dirname, "packages/core/src/parser/telemetry.ts"),
      "@claude-stats/core/energy": path.resolve(__dirname, "packages/core/src/energy.ts"),
      "@claude-stats/core/i18n": path.resolve(__dirname, "packages/core/src/i18n.ts"),
      "@claude-stats/core/types/team": path.resolve(__dirname, "packages/core/src/types/team.ts"),
      "@claude-stats/core/types/auth": path.resolve(__dirname, "packages/core/src/types/auth.ts"),
      "@claude-stats/core/types/api": path.resolve(__dirname, "packages/core/src/types/api.ts"),
      "@claude-stats/core/types/config": path.resolve(__dirname, "packages/core/src/types/config.ts"),
      "@claude-stats/core": path.resolve(__dirname, "packages/core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: [
      "packages/cli/src/__tests__/**/*.test.ts",
      "packages/infra/lambda/**/__tests__/**/*.test.ts",
    ],
    exclude: ["**/.claude/worktrees/**", "**/node_modules/**", "dist/**"],
    setupFiles: ["packages/cli/src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "packages/cli/src/**/*.ts",
        "packages/core/src/**/*.ts",
        "packages/infra/lambda/**/*.ts",
      ],
      exclude: [
        "packages/cli/src/index.ts",
        "packages/cli/src/cli/**",
        "packages/cli/src/extension/**",
        "packages/cli/src/sync/**",
        // Type-only files with no runtime code
        "packages/core/src/types.ts",
        "packages/core/src/types/**",
        "packages/core/src/index.ts",
        // Infra lambda tests have mock-setup issues being fixed separately
        "packages/infra/lambda/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        // v8 coverage reports different branch counts on Linux vs macOS
        // (Node 22 on Ubuntu CI: ~4% lower than macOS)
        branches: 71,
        statements: 80,
      },
    },
  },
});
