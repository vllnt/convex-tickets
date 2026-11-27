import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shared dev hosts: keep test parallelism low.
    maxWorkers: 2,
    // convex-test tests that open many tickets take seconds under coverage on a busy host.
    testTimeout: 30_000,
    environment: "edge-runtime",
    exclude: ["**/node_modules/**", "dist/**"],
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      include: [
        "src/shared.ts",
        "src/test.ts",
        "src/client/index.ts",
        "src/client/presets.ts",
        "src/client/tools.ts",
        "src/component/engine.ts",
        "src/component/queues.ts",
        "src/component/views.ts",
        "src/component/mutations.ts",
        "src/component/internal_mutations.ts",
        "src/component/queries.ts",
        "src/component/validators.ts",
        "src/component/schema.ts",
        "src/component/crons.ts",
        "example/convex/example.ts",
        "example/convex/hooks.ts",
        "example/convex/tickets.ts",
      ],
    },
  },
});
