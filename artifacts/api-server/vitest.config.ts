import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    testTimeout: 10000,
    // Integration tests share a single Postgres instance, so every file scopes
    // its reads/writes to a unique per-run tenant and asserts only on rows it
    // seeded (no global table snapshots or "count every row" assertions). That
    // makes cross-file parallelism safe. We cap the worker pool so the
    // container's throttled CPU isn't over-subscribed (which previously starved
    // workers until mocked unit tests blew past testTimeout). Vitest 4 moved
    // these to top-level options (poolOptions was removed).
    maxWorkers: 4,
    minWorkers: 1,
    globalSetup: ["./src/test-setup/global-setup.ts"],
  },
});
