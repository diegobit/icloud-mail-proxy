import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Installs crypto.subtle.timingSafeEqual under Node (Workers has it).
    setupFiles: ["test/support/workers-crypto.ts"],
    // The workerd integration suites (OAuth and sending) each boot wrangler's
    // dev server; starting several in parallel starves them (observed as
    // beforeAll timeouts on a busy machine and in CI), so test files run one
    // at a time. The unit suites are milliseconds each.
    fileParallelism: false,
  },
});
