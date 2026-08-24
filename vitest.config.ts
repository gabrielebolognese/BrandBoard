import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The database-backed suites share one board and TRUNCATE between tests, so
    // they must not run alongside each other. The claim tests also assert on
    // total tile counts, which another file's writes would corrupt.
    fileParallelism: false,
  },
});
