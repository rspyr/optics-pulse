import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    testTimeout: 10000,
    // Integration tests run against a dedicated, disposable database that
    // global-setup provisions per run (a fresh schema-cloned `mos_test_*` DB,
    // dropped on teardown — see src/test-setup/global-setup.ts), so cross-file
    // writes can't collide and global-count assertions are safe. We still cap
    // the worker pool so the container's throttled CPU isn't over-subscribed
    // (which previously starved workers until mocked unit tests blew past
    // testTimeout). Vitest 4 moved these to top-level options (poolOptions was
    // removed).
    maxWorkers: 4,
    minWorkers: 1,
    globalSetup: ["./src/test-setup/global-setup.ts"],
  },
});
