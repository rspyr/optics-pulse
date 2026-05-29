import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    testTimeout: 10000,
    // Integration tests share a single Postgres instance and some assert on
    // global table state (e.g. createDemoLead snapshots every lead id before/
    // after to find the one new row). Running test files concurrently both
    // pollutes that shared DB (concurrent inserts from sibling files) and
    // over-subscribes the container's throttled CPU, starving workers until
    // mocked unit tests blow past testTimeout. Run files sequentially so the
    // suite is deterministic and trustworthy. Tests within a file still run in
    // order; this only disables cross-file parallelism.
    fileParallelism: false,
    globalSetup: ["./src/test-setup/global-setup.ts"],
  },
});
