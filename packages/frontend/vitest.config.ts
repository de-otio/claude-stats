import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// The SPA's tests run in their OWN vitest project: they need a DOM
// (`jsdom`) and the React/JSX transform, neither of which the repo-root
// `vitest.config.ts` provides (it is Node-only and scoped to cli + infra).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
